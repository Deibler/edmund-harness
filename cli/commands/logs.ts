/**
 * `edmund logs [level flags] [--follow] [--session X] [--scope Y] [--grep RE] [-n N]`
 *
 * Prints the most recent lines (default 200), optionally follows. Level
 * flags (--error --warn --info --debug) are additive; none = everything.
 *
 * The underlying daemon log is `ISO [level] [tag] message ...`, with two
 * subprocess variants prefixed `mcp[<session>] ` / `agent[<id>] ` by their
 * log sinks. Everything is reformatted on read into fixed columns so the
 * same fields always land in the same spot:
 *
 *   HH:MM:SS  LEVEL  scope            session             event              fields
 *   17:44:55  INFO   claude-pool      dm:+15550100001     MISS cold spawn    pool_size=1
 *   17:44:56  INFO   claude-worker    dm:+15550100001     tool_use Bash      id=toolu_…
 *   17:44:58  INFO   tool             dm:+15550100001     ✓ send_message     dur=51ms
 *
 * The session column is the THREAD: it is filled from (in order) the
 * subprocess prefix, a `session=`/`key=` field, a leading `dm:`/`group:`
 * token, or a chat-spec field like `intended=any;-;+1555…` — so a whole
 * conversation (turns, tool calls, sends, verifies, cron fires, ghost
 * activity) lines up under one value, and `--session <substr>` follows it:
 *
 *   edmund logs -f --session +15550100003
 *
 * Scopes are colored by family: model runtime cyan, message plane blue,
 * tools/MCP green, scheduling yellow, ghost/proactive magenta, alerts red.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Parsed } from "../args.ts";
import { getString, hasFlag } from "../args.ts";
import { DAEMON_LOG, DASHBOARD_LOG, FISHING_LOG, TRADING_LOG } from "../services/paths.ts";
import { color, fail, print } from "../ui.ts";

type Level = "debug" | "info" | "warn" | "error";
const ALL_LEVELS: Level[] = ["debug", "info", "warn", "error"];

// Column widths, tuned for terminal width ~120. ANSI-safe (visibleLen-padded).
const W_LEVEL = 5;
const W_SCOPE = 16;
const W_SESSION = 19;
const W_EVENT = 22;

export async function logsCommand(p: Parsed): Promise<void> {
  const path = hasFlag(p, "fishing")
    ? FISHING_LOG
    : hasFlag(p, "trading")
      ? TRADING_LOG
      : hasFlag(p, "dashboard")
        ? DASHBOARD_LOG
        : DAEMON_LOG;
  const follow = hasFlag(p, "follow", "f");
  const activeLevels: Level[] = ALL_LEVELS.filter((l) => hasFlag(p, l));
  const levelFilter = activeLevels.length > 0 ? new Set(activeLevels) : null;
  const lineCount = getString(p, "lines", "n") ?? "200";

  const sessionFilter = getString(p, "session", "s")?.toLowerCase() ?? null;
  const scopeFilter = getString(p, "scope")?.toLowerCase() ?? null;
  let grepFilter: RegExp | null = null;
  const grepRaw = getString(p, "grep", "g");
  if (grepRaw) {
    try {
      grepFilter = new RegExp(grepRaw, "i");
    } catch (err) {
      fail(`bad --grep regex: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  const filters: Filters = {
    levels: levelFilter,
    session: sessionFilter,
    scope: scopeFilter,
    grep: grepFilter,
  };

  if (!existsSync(path)) {
    fail(`log not found: ${path}`);
    process.exit(1);
  }

  const tailArgs = follow ? ["-n", lineCount, "-F", path] : ["-n", lineCount, path];
  const child = spawn("tail", tailArgs, { stdio: ["inherit", "pipe", "inherit"] });

  const state: RenderState = { lastPassed: false };
  let carry = "";
  child.stdout.on("data", (chunk: Buffer) => {
    carry += chunk.toString("utf8");
    const lines = carry.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) writeLine(line, filters, state);
  });
  child.on("exit", (code) => {
    if (carry) writeLine(carry, filters, state);
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => {
    try {
      child.kill("SIGINT");
    } catch {}
    process.exit(0);
  });
}

type Filters = {
  levels: Set<Level> | null;
  session: string | null;
  scope: string | null;
  grep: RegExp | null;
};

/** `lastPassed` lets stack-trace continuation lines (no timestamp/level)
 *  follow their parent through the filters instead of being judged alone. */
type RenderState = { lastPassed: boolean };

function writeLine(raw: string, f: Filters, state: RenderState): void {
  if (!raw) return;
  const parsed = parseLine(raw);

  // Continuation line (stack frame, wrapped payload): inherit the parent's
  // filter verdict and render dim + indented, without fake columns.
  if (parsed.continuation) {
    if (state.lastPassed) print(color.dim(`          · ${raw.trim()}`));
    return;
  }

  if (f.levels && (!parsed.level || !f.levels.has(parsed.level as Level))) {
    state.lastPassed = false;
    return;
  }
  if (f.scope && !(parsed.scope ?? "").toLowerCase().includes(f.scope)) {
    state.lastPassed = false;
    return;
  }
  if (f.session && !(parsed.session ?? "").toLowerCase().includes(f.session)) {
    state.lastPassed = false;
    return;
  }
  if (f.grep && !f.grep.test(raw)) {
    state.lastPassed = false;
    return;
  }
  state.lastPassed = true;
  print(format(parsed));
}

export type ParsedLine = {
  ts: string | null;
  level: string | null;
  scope: string | null;
  session: string | null;
  event: string;
  fields: string;
  /** True for timestamp-less continuation lines (stack frames etc.). */
  continuation: boolean;
  /** True when the line came from a subprocess sink (mcp[…]/agent[…]). */
  subprocess: boolean;
};

export function parseLine(raw: string): ParsedLine {
  const tsM = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+/);
  let rest = tsM ? raw.slice(tsM[0].length) : raw;
  const lvlM = rest.match(/^\[(debug|info|warn|error|log)\]\s+/);
  let level: string | null = null;
  if (lvlM) {
    level = lvlM[1] === "log" ? "info" : (lvlM[1] ?? null);
    rest = rest.slice(lvlM[0].length);
  }

  // No timestamp AND no level ⇒ a continuation of the previous record
  // (multi-line error payloads, `    at foo (...)` stack frames).
  if (!tsM && !level) {
    return {
      ts: null,
      level: null,
      scope: null,
      session: null,
      event: raw.trim(),
      fields: "",
      continuation: true,
      subprocess: false,
    };
  }

  // Subprocess sink prefix: `mcp[dm:+1555…] ` / `agent[abc123] `. The
  // bracket payload is that process's session/thread identity.
  let subprocess = false;
  let prefixSession: string | null = null;
  const originM = rest.match(/^(mcp|agent)\[([^\]]+)\]\s+/);
  if (originM) {
    subprocess = true;
    prefixSession =
      originM[1] === "agent" ? `agent:${originM[2]}` : normalizeSession(originM[2] ?? "");
    rest = rest.slice(originM[0].length);
  }

  const scopeM = rest.match(/^\[([^\]]+)\]\s*/);
  let scope: string | null = null;
  if (scopeM) {
    scope = scopeM[1] ?? null;
    rest = rest.slice(scopeM[0].length);
  } else if (subprocess) {
    scope = originM?.[1] ?? null;
  }

  const { session: extracted, remainder } = extractSession(rest);
  const { event, fields } = splitEventFromFields(remainder);
  return {
    ts: tsM?.[1] ?? null,
    level,
    scope,
    session: prefixSession ?? extracted,
    event,
    fields,
    continuation: false,
    subprocess,
  };
}

/**
 * Pull the thread identity out of the line body, returning what's left.
 * Sources, in order:
 *   1. `session=dm:+1555…` / `session=imessage:group:…` — the field form
 *      structured logs use (consumed from the field tail).
 *   2. `key=imessage:…` — the old session-lock field name (consumed).
 *   3. A leading `dm:` / `group:` / `imessage:` token — inbound/outbound
 *      one-liners (consumed).
 *   4. A chat-spec field: `intended=any;-;+1555…`, `target=iMessage;-;…`,
 *      `to=…` — bridge/send-verify lines. NOT consumed (the raw value
 *      carries service info worth keeping visible); used only to fill the
 *      session column.
 */
function extractSession(text: string): { session: string | null; remainder: string } {
  const kvM = text.match(/(^|\s)session=("([^"]+)"|(\S+))/);
  if (kvM) {
    const raw = kvM[3] ?? kvM[4] ?? "";
    const before = text.slice(0, kvM.index ?? 0);
    const after = text.slice((kvM.index ?? 0) + kvM[0].length);
    return {
      session: normalizeSession(raw),
      remainder: (before + after).replace(/\s\s+/g, " ").trim(),
    };
  }
  const keyM = text.match(/(^|\s)key=(imessage:\S+)/);
  if (keyM) {
    const before = text.slice(0, keyM.index ?? 0);
    const after = text.slice((keyM.index ?? 0) + keyM[0].length);
    return {
      session: normalizeSession(keyM[2] ?? ""),
      remainder: (before + after).replace(/\s\s+/g, " ").trim(),
    };
  }
  const firstM = text.match(/^((?:imessage:)?(?:dm:|group:)\S+)\s+/);
  if (firstM) {
    return {
      session: normalizeSession(firstM[1] ?? ""),
      remainder: text.slice(firstM[0].length),
    };
  }
  const chatSpecM = text.match(
    /(?:^|\s)(?:intended|target|to|chat)=(?:"?)(?:any|iMessage|SMS);[+-];([^\s;"]+)/,
  );
  if (chatSpecM) {
    return { session: normalizeSession(`dm:${chatSpecM[1]}`), remainder: text };
  }
  return { session: null, remainder: text };
}

/** `imessage:dm:+X` → `dm:+X`; long group hashes truncated; bare handles
 *  promoted to `dm:<handle>` so prefix- and field-sourced sessions agree. */
export function normalizeSession(raw: string): string {
  const stripped = raw.replace(/^imessage:/, "");
  if (/^(dm:|group:|mirror:|orch:|agent:)/.test(stripped)) {
    return stripped.replace(/^(group:)[\w;+]*([a-f0-9]{6})[a-f0-9]*/i, "$1$2…");
  }
  if (/^\+?[\w.@-]+$/.test(stripped) && stripped.length > 3) return `dm:${stripped}`;
  return stripped;
}

/**
 * Split the remainder into an "event" (the natural-language part) and
 * "fields" (the key=val tail). Walks tokens left→right; stops collecting
 * event text the moment we see a `key=val` token.
 */
function splitEventFromFields(text: string): { event: string; fields: string } {
  if (!text) return { event: "", fields: "" };
  if (!text.includes("=")) return { event: text.trim(), fields: "" };
  const tokens = text.split(" ");
  const eventParts: string[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^[a-z_][a-z0-9_]*=/.test(t)) break;
    eventParts.push(t);
  }
  const event = eventParts.join(" ").trim();
  const fields = tokens.slice(i).join(" ").trim();
  return { event, fields };
}

/**
 * Scope families → colors, so the eye can separate the planes at a glance:
 *   cyan    model runtime (workers, pool, locks, compaction)
 *   blue    message plane (bridge, sends, watcher, delivery)
 *   green   tools & subprocesses (MCP tool calls, bg jobs, integrations)
 *   yellow  scheduling & recovery (cron, refresh, triggers, sweeps)
 *   magenta ghost / proactive / persona upkeep
 *   red     operator alerts
 * Unlisted scopes stay uncolored — new subsystems are visible as such.
 */
const SCOPE_FAMILIES: Array<[RegExp, (s: string) => string]> = [
  [
    /^(claude|claude-worker|claude-pool|session-lock|auto-compact|loadout|spend|session)$/,
    color.cyan,
  ],
  [
    /^(bridge|bridge-control|send|send-verify|outbound|inbound|watcher|auto-typing|outbox|gate|deliver|liveness|typing|imsg)/,
    color.blue,
  ],
  [/^(tool|mcp|agent|bg|background|skills|integrations|generation)/, color.green],
  [/^(cron|refresh|triggers|recovery|sweeper|boot|catchup|evals|daily)/, color.yellow],
  [/^(ghost|brown-nose|person-maintainer|proactive|annotate)/, color.magenta],
  [/^(alert|alerts)$/, color.red],
];

function colorScope(scope: string): string {
  for (const [re, paint] of SCOPE_FAMILIES) {
    if (re.test(scope)) return paint(scope);
  }
  return scope;
}

function format(p: ParsedLine): string {
  const t = p.ts ? color.dim(p.ts.slice(11, 19)) : "        ";
  const lvl = colorLevel(p.level);
  const scope = pad(p.scope ? colorScope(p.scope) : color.dim("-"), W_SCOPE);
  const session = pad(p.session ? color.magenta(p.session) : color.dim("-"), W_SESSION);
  const event = pad(p.event ? color.bold(p.event) : color.dim("·"), W_EVENT);
  const fields = p.fields ? color.dim(p.fields) : "";
  return [t, lvl, scope, session, event, fields].filter(Boolean).join("  ");
}

function colorLevel(level: string | null): string {
  const text = (level ?? "·").toUpperCase().padEnd(W_LEVEL);
  switch (level) {
    case "error":
      return color.red(text);
    case "warn":
      return color.yellow(text);
    case "debug":
      return color.dim(text);
    case "info":
      return color.green(text);
    default:
      return color.dim(text);
  }
}

/** Pad a possibly-ANSI-colored string to `width` visible chars. */
function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const gap = width - visible;
  return gap > 0 ? s + " ".repeat(gap) : s;
}
