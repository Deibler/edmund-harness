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
 *
 * By default the daemon log is shown as a story (cli/log-story.ts): who each
 * turn is for by name, one line per model step, subagents and wake-ups, the
 * heartbeat noise hidden, and while following, a line each minute naming
 * every turn still running. `--all` shows every line in the raw columns.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig } from "../../src/config/config.ts";
import { ChatDb } from "../../src/imessage/db.ts";
import { getGroupParticipants } from "../../src/imessage/participants.ts";
import { AddressBook } from "../../src/sessions/address-book.ts";
import { ContactBook } from "../../src/sessions/contacts.ts";
import type { Parsed } from "../args.ts";
import { getString, hasFlag } from "../args.ts";
import {
  type Story,
  type StoryState,
  newStoryState,
  tell,
  threadColors,
  workingLine,
} from "../log-story.ts";
import { DAEMON_LOG, DASHBOARD_LOG, FISHING_LOG, TRADING_LOG } from "../services/paths.ts";
import { color, color256, fail, print } from "../ui.ts";

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
  // The story view reads the daemon's own lines; other logs keep the raw view.
  const names = nameLookup();
  const story =
    !hasFlag(p, "all", "a") && path === DAEMON_LOG
      ? newStoryState(names.name, names.canonical)
      : null;
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

  const state: RenderState = { lastPassed: false, story };
  if (follow && story) {
    // A turn can run for half an hour with long quiet tool calls; say so.
    setInterval(() => {
      const line = workingLine(story, Date.now());
      if (line) print(color.dim(`${new Date().toTimeString().slice(0, 8)}  ·      ${line}`));
    }, 60_000);
  }
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
type RenderState = { lastPassed: boolean; story?: StoryState | null };

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
  if (f.grep && !f.grep.test(raw)) {
    state.lastPassed = false;
    return;
  }
  if (state.story) {
    const told = tell(parsed, state.story);
    if (!told || (f.session && !matchesSession(f.session, parsed, told))) {
      state.lastPassed = false;
      return;
    }
    state.lastPassed = true;
    print(formatStory(parsed, told));
    return;
  }
  if (f.session && !(parsed.session ?? "").toLowerCase().includes(f.session)) {
    state.lastPassed = false;
    return;
  }
  state.lastPassed = true;
  print(format(parsed));
}

/** `--session` matches the key (dm:+1555…) or the name the story shows ("hunter"). */
function matchesSession(want: string, p: ParsedLine, s: Story): boolean {
  return (p.session ?? "").toLowerCase().includes(want) || s.who.toLowerCase().includes(want);
}

const W_KIND = 10;
const W_WHO = 22;

/** One color per conversation for the life of this view, so a long log can be read by thread. */
const colorOf = threadColors();

function formatStory(p: ParsedLine, s: Story): string {
  const paint = s.thread ? color256(colorOf(s.thread)) : color.dim;
  // A bar in the conversation's color down the left edge, then the usual columns.
  const bar = s.thread ? paint("▌") : " ";
  const t = p.ts ? color.dim(p.ts.slice(11, 19)) : "        ";
  const lvl = s.tone === "bad" && p.level !== "error" ? color.yellow("WARN ") : colorLevel(p.level);
  const kind = pad(colorKind(s.kind), W_KIND);
  const name = s.who.length > W_WHO ? `${s.who.slice(0, W_WHO - 1)}…` : s.who;
  const who = pad(s.thread ? color.bold(paint(name)) : color.dim(name), W_WHO);
  const event = pad(
    s.tone === "bad" ? color.red(s.event) : s.tone === "dim" ? s.event : color.bold(s.event),
    W_EVENT,
  );
  const details = s.tone === "dim" ? color.dim(s.details) : s.details;
  return `${bar}${[t, lvl, kind, who, event, details].filter(Boolean).join("  ")}`;
}

/** Story kinds, colored so the eye finds the turns: people blue, the model cyan, its work green. */
function colorKind(kind: string): string {
  if (kind === "message" || kind === "sent") return color.blue(kind);
  if (kind === "model") return color.cyan(kind);
  if (kind === "step" || kind === "plan" || kind === "background") return color.green(kind);
  if (kind === "subagent" || kind === "wake" || kind === "proactive") return color.yellow(kind);
  if (kind === "memory") return color.dim(kind);
  return colorScope(kind);
}

/**
 * Names for sessions, from the operator's contacts and Messages: a DM by the
 * person's name, a group by its name or its members' first names. Built
 * lazily and cached; any failure leaves the raw key showing.
 */
function nameLookup(): {
  name: (session: string) => string | null;
  canonical: (session: string) => string | null;
} {
  let ready = false;
  let contacts: ContactBook | null = null;
  let chatDb: ChatDb | null = null;
  const groupIds = new Map<string, string | null>();
  const init = () => {
    ready = true;
    try {
      const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? "./config.toml");
      contacts = new ContactBook(config.contacts, new AddressBook());
      chatDb = new ChatDb(config.paths.chat_db);
    } catch {
      // No config or no Full Disk Access: names stay as keys.
    }
  };
  // Groups are logged by six hex characters of their id: the last six by most
  // subsystems, the first six by the memory maintainer. Either finds the chat.
  const groupGuid = (session: string): string | null => {
    const g = session.match(/^group:(?:[\w;+]*;)?([a-f0-9]{6,})…*$/i);
    if (!g) return null;
    if (groupIds.has(g[1]!)) return groupIds.get(g[1]!) ?? null;
    if (!ready) init();
    let guid: string | null = null;
    try {
      guid =
        (chatDb as ChatDb | null)
          ?.query<{ guid: string }>(
            "SELECT guid FROM chat WHERE guid LIKE ? AND guid LIKE '%;+;%' LIMIT 1",
          )
          .get(`%${g[1]}%`)?.guid ?? null;
    } catch {
      guid = null;
    }
    groupIds.set(g[1]!, guid);
    return guid;
  };
  return {
    canonical: (session) => {
      const guid = groupGuid(session);
      return guid ? `group:${guid}` : null;
    },
    name: (session) => {
      if (!ready) init();
      if (session.startsWith("dm:")) return contacts?.displayName(session.slice(3)) ?? null;
      const guid = groupGuid(session);
      if (!guid || !chatDb) return null;
      try {
        const row = (chatDb as ChatDb)
          .query<{ display_name: string | null }>(
            "SELECT display_name FROM chat WHERE guid = ? LIMIT 1",
          )
          .get(guid);
        if (row?.display_name?.trim()) return row.display_name.trim();
        const firsts = getGroupParticipants(chatDb as ChatDb, guid)
          .map((h) => ((contacts as ContactBook | null)?.displayName(h) ?? "").split(/\s+/)[0])
          .filter(Boolean)
          .slice(0, 3);
        return firsts.length ? `${firsts.join(", ")}${firsts.length === 3 ? "…" : ""}` : null;
      } catch {
        return null;
      }
    },
  };
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
  /** The session as logged, before display truncation; the story view keys names on it. */
  sessionKey?: string | null;
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

  // Subprocess sink prefix: `mcp[dm:+1555…] ` / `agent[abc123] ` /
  // `bg[bg_…] `. The bracket payload is that process's identity.
  let subprocess = false;
  let prefixSession: string | null = null;
  const originM = rest.match(/^(mcp|agent|bg)\[([^\]]+)\]\s+/);
  if (originM) {
    subprocess = true;
    prefixSession =
      originM[1] === "agent"
        ? `agent:${originM[2]}`
        : originM[1] === "bg"
          ? `bg:${originM[2]}`
          : normalizeSession(originM[2] ?? "");
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
    // The daemon already logs groups as `group:2045d3…`; do not add a second ellipsis.
    return stripped.replace(/^(group:)[\w;+]*([a-f0-9]{6})[a-f0-9]*…?/i, "$1$2…");
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
