import type { SessionPipeline } from "../channels/pipeline.ts";
import type { Config } from "../config/config.ts";
import type { InboundMessage } from "../imessage/types.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { sessionKeyFor } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { registerMount, unregisterMount } from "../web/mounts.ts";
import type { ConnectorBot } from "./auth.ts";
import {
  type GrokCaller,
  SHARED_CALLER,
  callerName,
  mismatchNote,
  reportMismatch,
} from "./caller.ts";
import { ExchangeLog } from "./exchanges.ts";
import type { ReportOutcome } from "./mcp.ts";
import { PendingTasks } from "./pending.ts";
import { GrokRelay } from "./relay.ts";
import { startGrokServer } from "./server.ts";
import { checkEdmund, printerLineFrom } from "./status.ts";

export type GrokChannel = {
  relay: GrokRelay;
  /** The loopback port the listener actually bound. */
  port: number;
  stop: () => void;
};

/** Longest bot result passed into the wake-up message; the rest is cut and said so. */
const MAX_WAKE_RESULT_CHARS = 12_000;
const MAX_WAKE_TASK_CHARS = 400;

/**
 * report_to_edmund: validate the id, record the result, wake Edmund.
 *
 * Exported for tests. An id Edmund never issued, one that expired (24 h) or one
 * already delivered is never turned into a turn. A result that arrives while a
 * `grokbot_task(wait_for_result)` call is blocked on it is handed to that call
 * and wakes no one, so Edmund is not told twice.
 *
 * It wakes Edmund in the session the task was asked from (`task.origin`: a group
 * chat if it was handed over there), the owner's DM when that is not recorded.
 *
 * `caller` is who the key says is reporting. `PendingTask.bot` is the bot the
 * task was sent to. A report on a different bot's own key is still accepted (a
 * bot may hand the id to another, or Grok may route a routine through the wrong
 * connector) but is flagged in what wakes Edmund and in the audit line. The
 * shared key is accepted as before, with no flag: it cannot say which bot it is.
 */
export function handleReport(
  deps: {
    pending: PendingTasks;
    relay: Pick<GrokRelay, "report">;
    now?: () => number;
  },
  rawId: string,
  result: string,
  caller: GrokCaller = SHARED_CALLER,
): ReportOutcome {
  const found = deps.pending.lookup(rawId);
  if (found.status === "unknown") {
    return {
      ok: false,
      error:
        "Edmund has no task with that reply_id. Use the reply_id exactly as it was given in the task he sent you. Nothing was delivered.",
    };
  }
  if (found.status === "expired") {
    return {
      ok: false,
      error:
        "That task is more than a day old and has expired, so Edmund is no longer waiting for it. Nothing was delivered.",
    };
  }
  if (found.status === "reported") {
    return { ok: true, text: "Edmund already has the result for that task. Thanks." };
  }
  const { task } = found;
  const waiting = task.waitUntilMs > (deps.now ?? Date.now)();
  deps.pending.complete(task.replyId, result, caller.kind === "bot" ? caller.bot : undefined);
  const mismatch = reportMismatch(task.bot, caller);
  if (mismatch) {
    log.warn("grok", "report arrived on another bot's own key", {
      replyId: task.replyId,
      sentTo: task.bot,
      reportedBy: caller.kind === "bot" ? caller.bot : undefined,
    });
  }
  if (!waiting) {
    deps.relay.report(
      reportMessage(task.replyId, task.bot, task.task, result, caller),
      `Grok Bot finished task ${task.replyId}${mismatch ? ` (reported on ${callerName(caller)}'s key, task was sent to "${task.bot}")` : ""}`,
      caller,
      task.origin,
    );
  }
  return { ok: true };
}

/** The inbound that wakes Edmund when a Grok Bot hands a task back. `reporter`
 *  is who presented the key the report arrived on. */
export function reportMessage(
  replyId: string,
  bot: string,
  task: string,
  result: string,
  reporter: GrokCaller = SHARED_CALLER,
): string {
  const cut = result.length > MAX_WAKE_RESULT_CHARS;
  const asked = task.length > MAX_WAKE_TASK_CHARS ? `${task.slice(0, MAX_WAKE_TASK_CHARS)}…` : task;
  const mismatch = mismatchNote(bot, reporter);
  return [
    `Grok Bot finished task ${replyId} (bot "${bot}"). Here is the result.`,
    ...(mismatch ? [mismatch] : []),
    `The task you gave it: ${JSON.stringify(asked)}`,
    "Result:",
    cut
      ? `${result.slice(0, MAX_WAKE_RESULT_CHARS)}\n[result cut at ${MAX_WAKE_RESULT_CHARS} characters]`
      : result,
  ].join("\n\n");
}

/**
 * Start the Grok channel: the relay, the log of what was said, and the MCP
 * listener. Returns null when it cannot run safely (no handle, no token) so a
 * misconfigured section never opens an unauthenticated door.
 */
export function createGrokChannel(opts: {
  config: Config;
  pipeline: SessionPipeline;
  contacts: ContactBook;
  /** The chat guid a DM session already uses (its session row), if it has one. */
  chatGuidFor?: (sessionKey: string) => string | undefined;
  /** Whether a turn is running in the person's DM session right now. */
  turnRunning?: (sessionKey: string) => boolean;
}): GrokChannel | null {
  const { config, pipeline, contacts, chatGuidFor } = opts;
  const grok = config.grok;
  if (!grok.handle) {
    log.warn("grok", "enabled but [grok].handle is unset — channel not started");
    return null;
  }
  if (!grok.token) {
    log.warn("grok", "enabled but [grok].token is unset — channel not started");
    return null;
  }
  const bots = connectorBotsOf(grok);
  const exchanges = new ExchangeLog(config.paths.data_dir);
  const relay = new GrokRelay({
    handle: grok.handle,
    contacts,
    chatGuidFor,
    enqueue: (key, msg) => pipeline.enqueue(key, msg),
    exchanges,
    answerTimeoutMs: grok.answer_timeout_ms,
    slowReply: grok.slow_reply,
    maxReplyChars: grok.max_reply_chars,
  });
  const pending = new PendingTasks(config.paths.data_dir);
  const dmKey = sessionKeyFor(
    { isGroup: false, fromHandle: grok.handle, chatIdentifier: grok.handle } as InboundMessage,
    contacts,
  );
  const printerName = (config as { printer?: { name?: string } }).printer?.name;
  // A side channel must never take the daemon down: a port already taken (the
  // kitchen host sits on a neighbouring one) logs and leaves Grok off.
  let server: ReturnType<typeof startGrokServer>;
  try {
    server = startGrokServer({
      port: grok.port,
      token: grok.token,
      bots,
      authMode: grok.auth_mode,
      maxMessageChars: grok.max_message_chars,
      requestsPerMinute: grok.requests_per_minute,
      asksPerMinute: grok.asks_per_minute,
      maxAuthFailures: grok.max_auth_failures,
      ask: (message, caller) => relay.ask(message, caller),
      tell: (message, caller) => relay.tell(message, caller),
      check: (caller) => {
        log.info("grok", "check_edmund", { caller: callerName(caller) });
        return checkEdmund({
          exchanges,
          turnRunning: () => opts.turnRunning?.(dmKey) ?? false,
          printerLine: printerLineFrom(config.paths.data_dir, fetch, printerName || undefined),
        });
      },
      report: (replyId, result, caller) =>
        handleReport({ pending, relay }, replyId, result, caller),
    });
  } catch (err) {
    log.error("grok", `listener failed on 127.0.0.1:${grok.port} — channel not started`, {
      err: String(err),
    });
    return null;
  }
  // The kitchen host owns the machine's one named tunnel; claiming "/grok/"
  // there gives the connector a permanent URL that survives restarts.
  try {
    registerMount(config.paths.data_dir, "/grok/", server.port);
  } catch (err) {
    log.warn("grok", "could not register the /grok/ mount", { err: String(err) });
  }
  return {
    relay,
    port: server.port,
    stop: () => {
      unregisterMount(config.paths.data_dir, "/grok/");
      server.stop();
    },
  };
}

/**
 * The bots that have a connector key of their own, from `[grok.bots.<name>]`.
 * A bot without `connector_token` simply has none and calls on the shared key.
 * A token that repeats the shared key or another bot's cannot name anyone, so it
 * is dropped, loudly (the name, never the token).
 */
export function connectorBotsOf(grok: Config["grok"]): ConnectorBot[] {
  const out: ConnectorBot[] = [];
  const seen = new Map<string, string>();
  if (grok.token) seen.set(grok.token, "the shared [grok].token");
  for (const [name, bot] of Object.entries(grok.bots ?? {})) {
    const token = bot.connector_token;
    if (!token) continue;
    const clash = seen.get(token);
    if (clash) {
      log.warn(
        "grok",
        `[grok.bots.${name}].connector_token repeats ${clash}; ignored, so ${name} cannot be told apart by its key`,
      );
      continue;
    }
    seen.set(token, `[grok.bots.${name}].connector_token`);
    out.push({
      name,
      token,
      label: bot.label?.trim() || name,
      ...(bot.description?.trim() ? { description: bot.description.trim() } : {}),
    });
  }
  return out;
}
