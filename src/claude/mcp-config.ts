import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.ts";
import * as intSettings from "../integrations/settings.ts";
import { hostAccess, tierForSessionKey } from "../security/policy.ts";
import { log } from "../util/log.ts";
import { directClaudeEnv } from "./direct-env.ts";

// `src/mcp/server.ts` relative to this module (`src/claude/mcp-config.ts`) —
// anchored via import.meta.url so the lookup doesn't break if a caller has
// a different cwd than the daemon.
const SERVER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "mcp", "server.ts");

/**
 * MCP config bundle written once per process. Two variants:
 *
 *  - `default`: just the in-repo `edmund-harness` server. ~70% of turns
 *    don't need a browser, and chrome-devtools-mcp adds 500-1500ms of
 *    Puppeteer + Chrome connection setup on every cold worker spawn.
 *  - `withBrowser`: default + chrome-devtools. Used only when the
 *    incoming envelope looks like it needs browser control (see
 *    `envelopeNeedsBrowser` below).
 *
 * Per-turn selection: the runner picks one and includes the choice in
 * the worker's rebindKey so warm-reuse still works — a session that
 * recently sent a screenshot request stays bound to a withBrowser worker
 * and reuses Chrome across follow-ups.
 *
 * Tool-schema deferral: all MCP schemas defer, loading on demand when the
 * model calls (or ToolSearches) a tool. Measured 2026-07-28 on CLI
 * 2.1.220: the 36 RadarOmega tools alone cost ~20k tokens eager vs ~0
 * deferred; the full 125-tool loadout is ~40k+. The system prompt's tool
 * catalog (system-prompt.ts) is what teaches the model the tool NAMES +
 * usage; schemas auto-load on first call, so deferral costs no extra
 * round-trips.
 *
 * This used to ride on the CLI default and silently stopped doing so. The
 * deferral budget is 10% of the CONTEXT WINDOW, so moving the persona to
 * `claude-opus-5[1m]` raised it from 20k (200k window) to 100k — the whole
 * loadout fit under it and every schema went back to loading eagerly, with
 * nothing in the logs to say so. `toolEnv` now pins the budget explicitly
 * rather than inheriting a window-relative default. Still do NOT set
 * ENABLE_TOOL_SEARCH=false or CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS in the
 * daemon's env — loadout-check.ts warns at boot if either leaks in.
 */
export type McpConfigPaths = {
  default: string;
  withBrowser: string;
  trading: string;
  /** Guest sessions: the in-repo server ONLY. RadarOmega and chrome-devtools
   *  are foreign server processes that in-server filtering can't touch, so
   *  keeping them out of guest turns has to happen here, at the file. */
  guest: string;
};

export function ensureMcpConfig(config: Config): McpConfigPaths {
  const defaultPath = join(config.paths.data_dir, "mcp.json");
  const browserPath = join(config.paths.data_dir, "mcp-browser.json");
  const tradingPath = join(config.paths.data_dir, "mcp-trading.json");
  const guestPath = join(config.paths.data_dir, "mcp-guest.json");

  const harnessOnly: Record<string, unknown> = {
    "edmund-harness": {
      // Codex launches MCP servers without a login shell and may normalize
      // PATH. Resolve Bun now so both CLIs start the exact same server.
      command: findBin("bun") ?? "bun",
      args: [SERVER_PATH],
    },
  };
  writeFileSync(guestPath, JSON.stringify({ mcpServers: harnessOnly }, null, 2));

  const coreServers: Record<string, unknown> = { ...harnessOnly };
  const radarOmegaServer = radarOmegaMcpServer(config);
  if (radarOmegaServer) {
    coreServers.radaromega = radarOmegaServer;
  }

  writeFileSync(defaultPath, JSON.stringify({ mcpServers: coreServers }, null, 2));

  // Trading loadout — core edmund-harness server PLUS the hosted Robinhood MCP,
  // declared EXPLICITLY here. Workers run with --strict-mcp-config (they don't
  // inherit ~/.claude.json servers), so this file is the *only* place the
  // Robinhood server exists — which is exactly how it stays OUT of the edmund
  // persona (whose mcp.json omits it) and present only in trading sessions.
  // The OAuth token is cached by URL (from the prior `claude mcp add` + login),
  // so this same-URL http server reuses that auth headlessly. A static bearer
  // token may also be supplied via [trading.mcp_headers].
  const robinhoodUrl = intSettings.trading(config)?.mcp_url ?? "";
  const robinhoodHeaders = intSettings.trading(config)?.mcp_headers ?? {};
  const tradingServers: Record<string, unknown> = { ...coreServers };
  if (robinhoodUrl) {
    tradingServers.robinhood = {
      type: "http",
      url: robinhoodUrl,
      ...(Object.keys(robinhoodHeaders).length > 0 ? { headers: robinhoodHeaders } : {}),
    };
  }
  Object.assign(tradingServers, intSettings.trading(config)?.mcp_servers ?? {});
  writeFileSync(tradingPath, JSON.stringify({ mcpServers: tradingServers }, null, 2));

  // Browser control — Chrome DevTools MCP. Uses installed Google Chrome via
  // --channel stable; profile persists at ~/.cache/chrome-devtools-mcp/
  // chrome-profile so logins survive across sessions. No macOS perms needed.
  const chromeDevtoolsBin = findBin("chrome-devtools-mcp");
  const browserServers: Record<string, unknown> = { ...coreServers };
  if (chromeDevtoolsBin) {
    browserServers["chrome-devtools"] = {
      command: chromeDevtoolsBin,
      args: ["--channel", "stable"],
    };
  } else {
    log.warn(
      "mcp-config",
      "chrome-devtools-mcp not found — install with npm i -g chrome-devtools-mcp",
    );
  }

  writeFileSync(browserPath, JSON.stringify({ mcpServers: browserServers }, null, 2));
  return { default: defaultPath, withBrowser: browserPath, trading: tradingPath, guest: guestPath };
}

/**
 * Conservative heuristic: does this envelope text look like the model is
 * likely to want a browser? Hits trigger the heavier mcp config (and a
 * separate worker bind), so we'd rather err on the side of false-negatives
 * (the model can decline; user can rephrase) than load Chrome on every turn.
 *
 * Triggers on:
 *   - http(s):// URL anywhere in the envelope (the model often follows links)
 *   - keywords that strongly signal browser intent: screenshot, navigate,
 *     scrape, browse, open … in chrome, take a snapshot of …
 */
const BROWSER_KEYWORDS =
  /\b(screenshot|navigate to|browse|scrape|click on|take a snapshot|fill the form|chrome|devtools|page source|render the page)\b/i;
const URL_RE = /https?:\/\/[^\s<>"']{6,}/i;

export function envelopeNeedsBrowser(envelope: string): boolean {
  if (URL_RE.test(envelope)) return true;
  if (BROWSER_KEYWORDS.test(envelope)) return true;
  return false;
}

/**
 * Resolve an executable by name across the locations that survive the
 * LaunchAgent's minimal PATH. The LaunchAgent plist adds /opt/homebrew and
 * /usr/local but not ~/.nvm/..., so npm-global bins (chrome-devtools-mcp,
 * peekaboo-mcp) live outside its PATH and must be referenced absolutely.
 */
export function findBin(name: string): string | null {
  return findBins(name)[0] ?? null;
}

/**
 * Return every installed executable candidate in deterministic discovery
 * order. Most callers want `findBin`; provider runners can use the full list
 * when multiple global package managers have installed different versions.
 */
export function findBins(name: string): string[] {
  const home = homedir();
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .map((dir) => join(dir, name)),
    ...nvmNodeBins(home, name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `${home}/.local/bin/${name}`,
  ];
  return [...new Set(candidates)].filter((p) => existsSync(p));
}

/**
 * `bin/<name>` under every installed nvm node version (empty when nvm isn't
 * present). npm-global CLIs like chrome-devtools-mcp / peekaboo-mcp install
 * into the active node's bin — which the LaunchAgent PATH doesn't include — so
 * we probe nvm's version dirs directly instead of pinning one node version
 * (the old hardcoded v24.13.0 broke the moment node was upgraded).
 */
function nvmNodeBins(home: string, name: string): string[] {
  try {
    const base = `${home}/.nvm/versions/node`;
    return readdirSync(base)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => `${base}/${v}/bin/${name}`);
  } catch {
    return [];
  }
}

function radarOmegaMcpServer(config: Config): Record<string, unknown> | null {
  if (!intSettings.radaromega(config).enabled) return null;

  const packagePath = resolve(intSettings.radaromega(config).package_path);
  const serverPath = join(packagePath, "dist", "index.js");
  if (!existsSync(serverPath)) {
    log.warn("mcp-config", "RadarOmega MCP server not found", {
      path: serverPath,
    });
    return null;
  }

  const nodeBin = findBin("node") ?? "node";
  return {
    command: nodeBin,
    args: [serverPath],
    env: {
      CDP_PORT: String(intSettings.radaromega(config).cdp_port),
    },
  };
}

export function toolEnv(
  config: Config,
  sessionKey: string,
  sandboxPath: string,
  /**
   * Depth of the inbound envelope being handled this turn — 0 for an
   * organic iMessage, N for a relay arriving at depth N. Read by the
   * `send_message` MCP tool to enforce MAX_RELAY_DEPTH.
   */
  inboundDepth = 0,
  /**
   * Guest-access tier of this session's sender, or null for the full
   * operator loadout. Read by the MCP server (src/mcp/server.ts), which
   * simply does not register the excluded tools for guest tiers —
   * structural, not prompt-forbidden.
   */
  guestTier: "keyed-guest" | "vouched" | null = null,
): Record<string, string> {
  const access = hostAccess(config);
  const tier = tierForSessionKey(config, sessionKey, guestTier);
  return {
    ...directClaudeEnv({}, access),
    // Both of these are sized as a FRACTION of the model's context window,
    // so `[1m]` switched them off without a word: the tool-schema deferral
    // budget went to 100k (the whole loadout fits, nothing defers) and
    // auto-compact stopped firing until sessions were already past 400k.
    // Pinning them in absolute terms keeps the 1M window available for the
    // rare turn that needs it while restoring the deferral this file's
    // header assumes and capping the routine turn's re-read.
    ENABLE_TOOL_SEARCH: "auto:1",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000",
    EDMUND_CONFIG_PATH: resolve("./config.toml"),
    EDMUND_SESSION_KEY: sessionKey,
    EDMUND_INBOUND_DEPTH: String(inboundDepth),
    // Always set, so a tool process never has to guess. Guests keep their
    // tier names; everyone else is "operator" or "contact" per [security].
    EDMUND_SESSION_TIER: tier,
    EDMUND_HOST_ACCESS: access,
    // Detached agents (spawned from the MCP server, which inherits this
    // env) read their model from here — see scripts/agent-runner.ts.
    EDMUND_AGENT_MODEL: config.claude.agent_model,
    EDMUND_AGENT_EFFORT: config.claude.agent_effort ?? config.claude.effort,
    ...(config.claude.context_window_tokens
      ? { EDMUND_CONTEXT_WINDOW_TOKENS: String(config.claude.context_window_tokens) }
      : {}),
    EDMUND_OPENAI_KEY: config.keys.openai,
    EDMUND_GEMINI_KEY: config.keys.gemini,
    EDMUND_ELEVENLABS_KEY: config.keys.elevenlabs,
    // instant-share: global tunnel/auth state lives in data/, but the actual
    // artifact (HTML) is built inside the per-session sandbox so everything
    // produced for this conversation stays scoped to it.
    INSTANT_SHARE_CONFIG_DIR: resolve(config.paths.data_dir, "instant-share"),
    INSTANT_SHARE_ARTIFACT_DIR: sandboxPath,
    // Admin password for the share server's /admin panel. Blank disables login.
    INSTANT_SHARE_ADMIN_PASSWORD: config.instant_share?.admin_password ?? "",
    // Consumed by the PreToolUse path guard in scripts/guard-path.ts.
    EDMUND_SANDBOX_PATH: sandboxPath,
    EDMUND_DATA_DIR: resolve(config.paths.data_dir),
  };
}
