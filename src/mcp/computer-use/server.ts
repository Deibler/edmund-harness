#!/usr/bin/env bun
/**
 * Computer-use MCP server: lets a session see and drive this Mac's screen.
 *
 * Claude Code's built-in computer-use server only runs in interactive
 * sessions, and Edmund's sessions are headless (`claude -p`), so this is the
 * harness's own. Same tools, same parameters, same rules, plus two things the
 * built-in does not need because a person is watching it: apps are approved
 * in [computer_use] rather than in a dialog, and every action passes a Jev
 * safety check before it runs.
 *
 *   server.ts   entry: config, session tier, MCP wiring
 *   tools.ts    the tool definitions
 *   session.ts  grants, the coordinate reference, the gates, every action
 *   guard.ts    the Jev safety check
 *   request.ts  what the person actually asked, from chat.db
 *   scope.ts    whose conversation and whose lists this session may touch
 *   describe.ts actions in words, for the safety check
 *   policy.ts   approved apps and app tiers
 *   keys.ts     key chord parsing, shortcut meanings, refused shortcuts
 *   geometry.ts screenshot sizing and pixel-to-point mapping
 *   lock.ts     one conversation on the screen at a time
 *   native.ts   client for native/helper.swift (capture and input)
 *
 * The owner's own DM gets `apps`; every other DM and group gets
 * `contact_apps`, only while the safety check enforces. Guests, sessions
 * that are not a conversation, and any session without an OpenRouter key for
 * the check see an empty list (sessionPolicy).
 *
 * One conversation drives the screen at a time. It holds the screen until
 * its turn ends, and then quits the apps it launched (lock.ts).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type Config, loadConfig } from "../../config/config.ts";
import { initRegistryFromConfig } from "../../integrations/registry.ts";
import { isGuestTier, isOperatorHandle, parseSessionTier } from "../../security/policy.ts";
import { installLogSinkFromEnv } from "../../util/log-sink.ts";
import { humanMs, log } from "../../util/log.ts";
import { protectStdout } from "../stdio-safety.ts";
import type { ToolDef } from "../tools/types.ts";
import { zodToJsonSchema } from "../zod-to-json.ts";
import { type AuditEntry, JevGuard } from "./guard.ts";
import { END_HOLD_SIGNAL, HOLD_IDLE_MS, ScreenLock, screenLockPath } from "./lock.ts";
import { NativeHelper } from "./native.ts";
import type { Policy } from "./policy.ts";
import { requestReader } from "./request.ts";
import { type Scope, describeConversation, loadScope } from "./scope.ts";
import { ComputerSession } from "./session.ts";
import { INSTRUCTIONS, computerTools } from "./tools.ts";

/** iMessage and SMS conversations: the only sessions that act on the screen. */
const CHAT_SESSION = /^(?:imessage|sms):(dm|group):(.+)$/;

/**
 * The [computer_use] policy for this session, or null when it gets no tools.
 *
 * The owner is judged by handle: the session is a DM with one of the
 * operator's own handles ([security] operator_handles, else
 * [alerts] operator_handle). The session tier cannot answer this, because
 * `[security] contact_tier = "operator"` gives every allowlisted contact and
 * group the operator's host access, and the screen is not host access.
 *
 * Everyone else in a DM or a group gets the contact policy, and only while
 * the safety check enforces. Nothing gets tools when the section is
 * disabled, there is no key for the check, the session is a guest's, or it
 * is not a conversation at all (the mirror, a sub-agent, a cron job with no
 * chat).
 */
export function sessionPolicy(
  config: Config | null,
  tierEnv: string | undefined,
  sessionKey: string,
): Policy | null {
  const section = config?.computer_use;
  if (!config || !section?.enabled || !config.keys.openrouter) return null;
  if (isGuestTier(parseSessionTier(tierEnv))) return null;
  const chat = CHAT_SESSION.exec(sessionKey);
  if (!chat) return null;
  if (chat[1] === "dm" && isOperatorHandle(config, chat[2])) {
    return {
      tier: "operator",
      apps: section.apps,
      clipboard: section.clipboard,
      systemKeyCombos: section.system_key_combos,
    };
  }
  if (section.classifier !== "enforce") return null;
  return { tier: "contact", apps: section.contact_apps, clipboard: false, systemKeyCombos: false };
}

/**
 * The apps this session may be granted, read from config.toml when asked, so
 * an edit reaches sessions that are already running. Nothing once computer
 * use is switched off (or, for a contact, once the check only shadows); the
 * list from startup if the file cannot be read right now, mid-edit say.
 */
export function currentApps(configPath: string, policy: Policy): string[] {
  let section: Config["computer_use"];
  try {
    section = loadConfig(configPath).computer_use;
  } catch (err) {
    log.warn("computer", "could not re-read the approved apps; using the list from startup", {
      err: (err as Error).message,
    });
    return policy.apps;
  }
  if (!section.enabled) return [];
  if (policy.tier === "operator") return section.apps;
  return section.classifier === "enforce" ? section.contact_apps : [];
}

async function main() {
  protectStdout();
  const sessionKey = process.env.EDMUND_SESSION_KEY ?? "";
  installLogSinkFromEnv(`computer[${sessionKey.replace(/^imessage:/, "")}] `);

  const configPath = resolve(process.env.EDMUND_CONFIG_PATH ?? "./config.toml");
  let config: Config | null = null;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    log.warn("computer", "no config; serving no tools", { err: (err as Error).message });
  }
  const policy = sessionPolicy(config, process.env.EDMUND_SESSION_TIER, sessionKey);
  const dataDir =
    process.env.EDMUND_DATA_DIR ?? resolve(dirname(configPath), config?.paths.data_dir ?? "data");

  const native = new NativeHelper();
  let session: ComputerSession | null = null;
  let guard: JevGuard | null = null;
  if (policy && config) {
    initRegistryFromConfig(config);
    const scope = await loadScope(config, sessionKey, policy.tier);
    guard = new JevGuard({
      apiKey: config.keys.openrouter,
      model: config.computer_use.classifier_model,
      threshold: config.computer_use.classifier_threshold,
      mode: config.computer_use.classifier,
      session: sessionKey,
      context: guardContext(scope),
      request: requestReader(config, sessionKey),
      audit: auditTo(join(dataDir, "computer-use", "verdicts.jsonl")),
    });
    session = new ComputerSession({
      native,
      policy,
      scope,
      guard,
      lock: new ScreenLock({ path: screenLockPath(dataDir), session: sessionKey }),
      approvedApps: () => currentApps(configPath, policy),
    });
  }
  const tools: ToolDef[] = session ? computerTools(session) : [];
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "computer-use", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: tools.length ? INSTRUCTIONS : undefined },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema, t.name),
    })),
  }));

  const serial = serialQueue();
  server.setRequestHandler(CallToolRequestSchema, (req) => serial(() => callTool(req.params)));

  async function callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    const tool = byName.get(params.name);
    if (!tool) {
      return { content: [{ type: "text", text: `unknown tool: ${params.name}` }], isError: true };
    }
    const started = Date.now();
    log.info("computer", `→ ${tool.name}`, summarize(tool.name, params.arguments));
    try {
      const result = await tool.handler(tool.inputSchema.parse(params.arguments ?? {}));
      log.info("computer", `${result.isError ? "✗" : "✓"} ${tool.name}`, {
        dur: humanMs(Date.now() - started),
        ...(result.isError ? { reply: result.content.find((c) => c.type === "text")?.text } : {}),
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("computer", `✗ ${tool.name} threw`, { err: msg });
      return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
    }
  }

  /**
   * Give up the screen and quit what this conversation opened. The daemon
   * signals the end of each turn (lock.ts); a holder that has sat idle past
   * HOLD_IDLE_MS lets go by itself, in case that signal never came. Queued
   * behind any call still running, so nothing closes mid-action.
   */
  const endHold = (why: string) =>
    serial(async () => {
      if (!session) return;
      if (why === "idle" && (session.idleFor() ?? 0) < HOLD_IDLE_MS) return;
      const ended = await session.endHold();
      if (!ended) return;
      log.info("computer", `screen released (${why})`, {
        quit: ended.quit.join(", ") || "nothing",
        ...(ended.stillOpen.length ? { still_open: ended.stillOpen.join(", ") } : {}),
      });
    });
  process.on(END_HOLD_SIGNAL, () => void endHold("turn ended"));
  setInterval(() => {
    if ((session?.idleFor() ?? 0) >= HOLD_IDLE_MS) void endHold("idle");
  }, 30_000).unref();

  let exiting = false;
  const shutdown = async () => {
    if (exiting) return;
    exiting = true;
    await Promise.race([endHold("server exiting"), delay(10_000)]);
    await guard?.drain(2_000);
    native.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("end", shutdown);

  await server.connect(new StdioServerTransport());
}

/** What the safety check is told about every action in this session. */
export function guardContext(scope: Scope): Record<string, string> {
  const lists = (titles: string[]) =>
    titles.length ? titles.map((t) => `"${t}"`).join(", ") : "none";
  return {
    requester: scope.requester,
    conversation: `the request came from ${describeConversation(scope.conversation)}`,
    requester_household_list: lists(scope.ownNotes),
    other_households_lists: lists(scope.otherNotes),
  };
}

/**
 * Every verdict, one JSON line each, for reviewing what the check allowed and
 * refused (the record shadow mode exists to build). Refusals also go to the
 * daemon log.
 */
function auditTo(path: string): (entry: AuditEntry) => void {
  return (entry) => {
    const v = entry.verdict;
    if (!v.allowed || v.wouldDeny) {
      log.warn("computer", `${v.allowed ? "would refuse" : "refused"} ${entry.tool}`, {
        action: entry.action,
        flagged: v.flagged.map((f) => `${f.harm}=${f.p.toFixed(2)}`).join(" "),
        err: v.error,
      });
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      log.warn("computer", "could not write the verdict log", { err: (err as Error).message });
    }
  };
}

/**
 * Run calls one at a time, in arrival order. The MCP SDK dispatches requests
 * concurrently and a model can issue tool calls in parallel, but there is one
 * screen: a click must not land while a screenshot is hiding apps, and
 * nothing may run before the request_access ahead of it has finished.
 */
export function serialQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Log what was asked without logging what was typed or copied. */
function summarize(
  tool: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const secret = tool === "type" || tool === "write_clipboard";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === "text" && secret && typeof v === "string") out.text = `(${v.length} chars)`;
    else if (k === "actions" && Array.isArray(v))
      out.actions = v.map((a) => (a as { action?: string }).action).join(",");
    else out[k] = v;
  }
  return out;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
