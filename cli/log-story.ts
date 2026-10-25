/**
 * The readable view of the daemon log: what the model is doing, for whom.
 *
 * The raw log carries every subsystem's heartbeat. Measured on 20,000 lines
 * (2026-10-25), most of it was background chatter: mirror reconnect flaps,
 * widget refreshes, recall progress bars, pool stats, "message finished
 * being written", and each MCP tool call written three times (the model's
 * tool_use, the server's call, the server's result). This view keeps the
 * same columns but changes what fills them:
 *
 *   time  level  kind      who                 event                details
 *   20:23:46 INFO message  Axolotl crew        ← Hunter Deibler     2 msgs, 1 attachment
 *   20:23:46 INFO model    Axolotl crew        working              cold start
 *   20:24:54 INFO step     Axolotl crew        Bash                 Check v1 support usage
 *   20:48:46 INFO model    Axolotl crew        done in 24m60s       43 steps · 202-char reply · $29.68 session
 *
 * Noise is hidden, not deleted: `edmund logs --all` shows every line. Lines
 * this view does not recognise are shown as they are, so a new subsystem is
 * visible the day it starts logging.
 */

import type { ParsedLine } from "./commands/logs.ts";

export type Story = {
  kind: string;
  who: string;
  event: string;
  details: string;
  /** "dim" for supporting lines, "bad" for failures, "" for the main story. */
  tone: "" | "dim" | "bad";
  /** The conversation this line is work for (a subagent's is its parent's), for coloring. */
  thread?: string | null;
};

export type Turn = { startedMs: number; lastMs: number; steps: number; last: string };

export type StoryState = {
  /** Session key (untruncated, e.g. dm:+1555…, group:any;+;abc…) -> display name. */
  names: Map<string, string>;
  /** Subagent id -> the session that spawned it. */
  agentParent: Map<string, string>;
  /** Sessions with a turn in progress. */
  turns: Map<string, Turn>;
  /** Resolve a session to a name when the log has not named it yet. */
  lookup?: (session: string) => string | null;
  /**
   * The full identity behind an abbreviated session. Subsystems shorten a
   * group to six characters of its id, some from the end and some from the
   * start; both must land on one thread.
   */
  canonical?: (session: string) => string | null;
};

export function newStoryState(
  lookup?: (session: string) => string | null,
  canonical?: (session: string) => string | null,
): StoryState {
  return { names: new Map(), agentParent: new Map(), turns: new Map(), lookup, canonical };
}

/** Lines that are background heartbeat, never the story. */
const NOISE: Array<[RegExp, RegExp]> = [
  [/^watcher$/, /message finished being written/],
  [/^claude-pool$/, /^(stats|evicting idle worker|worker died)/],
  [/^claude-worker$/, /^shutting down/],
  [/^sms$/, /^spend today/],
  [/^refresh$/, /^applied /],
  [/^recall$/, /./],
  [/^mirror$/, /^(screen disconnected|connected to|liveness timeout)/],
  [/^liveness$/, /./],
  [/^resources$/, /soft memory limit/],
  [/^integrations$/, /^loaded \d+/],
  [/^ghost-observer$/, /./],
  [/^credits$/, /^liability/],
  [/^persona-archive$/, /./],
  [/^addressing$/, /./],
  [/^session-lock$/, /lease extended/],
  [/^claude$/, /^(multimodal input|persona edited since|worker pool initialized)/],
  [/^evals$/, /./],
  [/^agent$/, /^runner starting/],
  [/^send_message$|^send_attachment$/, /./],
];

/** Tool calls that are bookkeeping, not work a person would want to watch. */
const QUIET_TOOLS = new Set(["ToolSearch", "check_incoming", "TaskUpdate", "TaskList", "TaskGet"]);

/**
 * A `key=value` or `key="value"` field from a log line's tail. The logger
 * escapes quotes inside a quoted value but not backslashes, so `\"` is a
 * quote and any other backslash is itself.
 */
export function field(text: string, key: string): string | null {
  const m = text.match(new RegExp(`(?:^|\\s)${key}=("((?:[^"\\\\]|\\\\"|\\\\(?!"))*)"|\\S+)`));
  if (!m) return null;
  return m[2] !== undefined ? m[2].replace(/\\"/g, '"') : (m[1] ?? null);
}

/** A string property from a (possibly truncated) JSON summary like `{"command":"ls","description":"List"}`. */
export function jsonString(summary: string, key: string): string | null {
  const m = summary.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)`));
  if (!m) return null;
  return m[1]!
    .replace(/…\(len=\d+\)$/, "…")
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The last two parts of a path: enough to recognise it. */
export function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** What a tool call is doing, in a few words, from its input. */
export function describeStep(tool: string, input: string): string {
  const s = (k: string) => jsonString(input, k);
  switch (tool) {
    case "Bash":
      return s("description") ?? clip(s("command") ?? "", 90);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return shortPath(s("file_path") ?? s("notebook_path") ?? "");
    case "Grep":
    case "Glob":
      return clip(s("pattern") ?? "", 90);
    case "WebSearch":
    case "web_search":
      return `"${clip(s("query") ?? "", 80)}"`;
    case "WebFetch":
    case "web_fetch":
      return clip((s("url") ?? "").replace(/^https?:\/\//, ""), 90);
    case "send_message":
      return `"${clip(s("text") ?? "", 80)}"`;
    case "send_attachment": {
      const cap = s("caption");
      return `${shortPath(s("file_path") ?? "")}${cap ? ` "${clip(cap, 60)}"` : ""}`;
    }
    case "react":
      return s("reaction") ?? "";
    case "remember_about_person":
    case "remember_about_self":
      return clip(s("note") ?? s("text") ?? "", 90);
    case "remember_about_subject":
      return clip(s("title") ?? "", 90);
    case "spawn_agent":
    case "Agent":
    case "Task":
      return clip(s("description") ?? s("task") ?? s("prompt") ?? "", 90);
    case "TaskCreate":
      return clip(s("subject") ?? "", 90);
    default: {
      const first = input.match(/"[a-z_]+":"((?:[^"\\]|\\.)*)/i)?.[1];
      return first ? clip(first.replace(/\\"/g, '"').replace(/…\(len=\d+\)$/, "…"), 90) : "";
    }
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The name to show for a session: learned from the log, else looked up, else the key itself. */
export function whoFor(state: StoryState, session: string | null): string {
  if (!session) return "-";
  if (session.startsWith("agent:")) {
    const id = session.slice(6);
    const parent = state.agentParent.get(id);
    const short = id.split("_").slice(-2, -1)[0] ?? id.slice(-6);
    return parent ? `↳ ${short} ${whoFor(state, parent)}` : `↳ subagent ${short}`;
  }
  if (session.startsWith("bg:")) return "background job";
  const known = state.names.get(session);
  if (known) return known;
  const looked = state.lookup?.(session) ?? null;
  if (looked) {
    state.names.set(session, looked);
    return looked;
  }
  if (session.startsWith("mirror:")) return "the mirror";
  return session.replace(/^(group:)[\w;+]*([a-f0-9]{6})[a-f0-9]*…?/i, "$1$2…");
}

/** A turn runs from the moment the model picks it up (not when a message lands: a group
 *  message Edmund lets pass never starts one) until its result line. */
function startTurn(state: StoryState, session: string, ms: number) {
  const t = state.turns.get(session);
  if (t) t.lastMs = ms;
  else state.turns.set(session, { startedMs: ms, lastMs: ms, steps: 0, last: "" });
}

/** A turn silent this long ended without a result line (a crash, a restart). */
const TURN_SILENT_MS = 45 * 60_000;

/** Turn a parsed line into a story line, or null to hide it. */
export function tell(p: ParsedLine, state: StoryState, nowMs = Date.now()): Story | null {
  const story = tellLine(p, state, nowMs);
  if (story)
    story.thread = threadOf(
      state,
      story.thread === undefined ? (p.sessionKey ?? p.session) : story.thread,
    );
  return story;
}

/** The conversation a session's work belongs to: a subagent's parent, nothing for background jobs. */
export function threadOf(state: StoryState, session: string | null): string | null {
  if (!session || session.startsWith("bg:")) return null;
  const s = session.startsWith("agent:")
    ? (state.agentParent.get(session.slice(6)) ?? session)
    : session;
  return state.canonical?.(s) ?? s;
}

function tellLine(p: ParsedLine, state: StoryState, nowMs: number): Story | null {
  const scope = p.scope ?? "";
  const text = `${p.event} ${p.fields}`.trim();
  const session = p.sessionKey ?? p.session;
  const who = () => whoFor(state, session);
  const ms = p.ts ? Date.parse(p.ts) : nowMs;

  for (const [s, t] of NOISE) if (s.test(scope) && t.test(text)) return null;
  if (/^\[?integrations\]? loaded/.test(text) || text.startsWith("computer[")) return null;

  // A message in.
  if (scope === "inbound") {
    const m = text.match(/^←\s+(.+?)\s{2,}(\d+)msgs?/);
    const sender = m?.[1]?.trim() ?? p.event.replace(/^←\s*/, "");
    if (session?.startsWith("dm:") && sender && !state.names.has(session))
      state.names.set(session, sender);
    const n = Number(m?.[2] ?? 1);
    const attach = Number(field(text, "attach") ?? 0);
    return {
      kind: "message",
      who: who(),
      event: `← ${clip(sender, 20)}`,
      details: `${plural(n, "msg")}${attach ? `, ${plural(attach, "attachment")}` : ""}`,
      tone: "",
    };
  }

  // The model picks the turn up.
  if (scope === "claude-pool" && /^(HIT|MISS)/.test(text)) {
    if (session) startTurn(state, session, ms);
    return {
      kind: "model",
      who: who(),
      event: "working",
      details: text.startsWith("HIT") ? "warm" : "cold start",
      tone: "",
    };
  }

  // A step.
  if (scope === "claude-worker" && p.event.startsWith("tool_use")) {
    const tool = p.event.replace(/^tool_use\s+/, "").trim() || (field(text, "tool") ?? "?");
    const input = field(text, "input_summary") ?? "";
    if (session) {
      startTurn(state, session, ms);
      const t = state.turns.get(session)!;
      t.steps++;
      t.last = tool;
    }
    if (QUIET_TOOLS.has(tool)) return null;
    const desc = describeStep(tool, input);
    if (tool === "Agent" || tool === "Task")
      return { kind: "subagent", who: who(), event: "started (in turn)", details: desc, tone: "" };
    if (tool === "TaskCreate")
      return { kind: "plan", who: who(), event: "to do", details: desc, tone: "dim" };
    return { kind: "step", who: who(), event: tool, details: desc, tone: "" };
  }

  // The turn ends.
  if (scope === "claude-worker" && p.event.startsWith("result")) {
    const ok = /^result ok/.test(text);
    const turn = session ? state.turns.get(session) : undefined;
    if (session) state.turns.delete(session);
    const dur = field(text, "dur") ?? "";
    const tools = field(text, "tools") ?? String(turn?.steps ?? 0);
    const reply = Number(field(text, "reply_chars") ?? 0);
    const ctx = field(text, "ctx");
    const total = field(text, "session_total");
    const bits = [
      plural(Number(tools), "step"),
      reply ? `${reply}-char reply` : "no reply",
      ctx ? `ctx ${ctx}` : "",
      total ? `${total} session` : "",
    ].filter(Boolean);
    return ok
      ? { kind: "model", who: who(), event: `done in ${dur}`, details: bits.join(" · "), tone: "" }
      : {
          kind: "model",
          who: who(),
          event: `failed after ${dur}`,
          details: clip(text.replace(/^result \S+\s*/, ""), 160),
          tone: "bad",
        };
  }

  if (scope === "outbound") {
    const chunks = text.match(/(\d+) chunk/)?.[1];
    return {
      kind: "sent",
      who: who(),
      event: "→ reply sent",
      details: chunks && chunks !== "1" ? `${chunks} parts` : "",
      tone: "dim",
    };
  }

  // Tool server lines: the model's own tool_use line already said it.
  if (scope === "tool") {
    const isAgent = session?.startsWith("agent:");
    if (p.event.startsWith("✗")) {
      return {
        kind: "step",
        who: who(),
        event: p.event,
        details: clip(field(text, "reply") ?? field(text, "err") ?? p.fields, 140),
        tone: "bad",
      };
    }
    if (isAgent && p.event.startsWith("→")) {
      const tool = p.event.replace(/^→\s*/, "").trim();
      if (QUIET_TOOLS.has(tool)) return null;
      return {
        kind: "step",
        who: who(),
        event: tool,
        details: describeStep(tool, field(text, "args") ?? ""),
        tone: "",
      };
    }
    return null;
  }

  // Subagents.
  if (scope === "agents") {
    const m = text.match(/^spawned (agent_\S+|team \S+)/);
    if (m) {
      const id = m[1]!.replace(/^team /, "");
      if (session) state.agentParent.set(id, session);
      return {
        kind: "subagent",
        who: who(),
        event: "started",
        details: `"${clip(field(text, "task") ?? "", 100)}"`,
        tone: "",
      };
    }
    if (/^reaper/.test(text))
      return {
        kind: "subagent",
        who: who(),
        event: "stopped by reaper",
        details: clip(p.fields, 120),
        tone: "bad",
      };
  }

  // Scheduled and follow-up wake-ups.
  if (scope === "cron") {
    if (/^fire ok/.test(text)) return null;
    const m = text.match(/^fire (\S+)/);
    if (m) {
      const what = field(text, "event") ?? "";
      if (m[1] === "agent-done") {
        const status = what.match(/status: (\w+)/)?.[1] ?? "done";
        return {
          kind: "subagent",
          who: who(),
          event: `finished (${status})`,
          details: `"${clip(what.replace(/^.*Task was:\s*/, ""), 90)}"`,
          tone: "",
        };
      }
      if (/failed|error/.test(m[1]!))
        return {
          kind: "cron",
          who: who(),
          event: m[1]!,
          details: clip(p.fields, 140),
          tone: "bad",
        };
      return {
        kind: "wake",
        who: who(),
        event: m[1] === "scheduled" ? "scheduled" : m[1]!,
        details: clip(what, 110),
        tone: "",
      };
    }
  }

  // Background jobs (video analysis, long fetches).
  if (scope === "bg") {
    const tool = field(text, "tool");
    if (/^runner starting/.test(text))
      return { kind: "background", who: who(), event: "started", details: tool ?? "", tone: "dim" };
    if (/^runner done/.test(text)) return null;
    if (/^runner failed/.test(text))
      return {
        kind: "background",
        who: who(),
        event: "failed",
        details: clip(field(text, "err") ?? p.fields, 140),
        tone: "bad",
      };
  }

  // Memory upkeep: worth a dim line when something changed.
  if (scope === "maintainer" || scope === "persona-consolidate") {
    if (/\+0 notes/.test(text) && !/superseded [1-9]/.test(text)) return null;
    const handle = field(text, "handle");
    const subject = handle
      ? handle.includes(";+;")
        ? `group:${handle.split(";").pop()}`
        : `dm:${handle}`
      : (p.sessionKey ?? p.session);
    return {
      kind: "memory",
      thread: subject,
      who: whoFor(state, subject),
      event: clip(p.event, 22),
      details: clip(field(text, "reason") ?? field(text, "revised") ?? p.fields, 120),
      tone: "dim",
    };
  }

  if (scope === "ghost") {
    if (/^decision/.test(text) && field(text, "act") === "true") {
      return { kind: "proactive", who: who(), event: "reaching out", details: "", tone: "" };
    }
    return null;
  }

  // Anything else, as it was: unknown lines stay visible.
  return {
    kind: scope || "-",
    who: who(),
    event: p.event,
    details: p.fields,
    tone: p.level === "error" ? "bad" : "",
  };
}

/** One line on every turn still in progress, for the follow view's minute tick. */
export function workingLine(state: StoryState, nowMs: number): string | null {
  for (const [s, t] of state.turns) if (nowMs - t.lastMs > TURN_SILENT_MS) state.turns.delete(s);
  if (state.turns.size === 0) return null;
  const parts = [...state.turns.entries()]
    .sort((a, b) => a[1].startedMs - b[1].startedMs)
    .map(([s, t]) => {
      const mins = Math.max(0, Math.round((nowMs - t.startedMs) / 60_000));
      return `${whoFor(state, s)} ${mins}m${t.steps ? `, ${plural(t.steps, "step")}${t.last ? `, last ${t.last}` : ""}` : ""}`;
    });
  return `still working: ${parts.join(" | ")}`;
}

/**
 * Each conversation's color in the log view: stable across runs where it can
 * be (a hash of the session picks the first choice), distinct within a run
 * (a color already given to another conversation is skipped). Red is kept for
 * errors. xterm-256 codes, legible on dark and light terminals.
 */
export const THREAD_PALETTE = [
  39, 208, 141, 78, 214, 170, 45, 172, 111, 149, 177, 74, 179, 37, 205, 117,
];

export function threadColors(): (thread: string) => number {
  const given = new Map<string, number>();
  const used = new Set<number>();
  return (thread: string) => {
    const known = given.get(thread);
    if (known !== undefined) return known;
    let h = 0;
    for (const ch of thread) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    let i = h % THREAD_PALETTE.length;
    for (let k = 0; k < THREAD_PALETTE.length && used.has(THREAD_PALETTE[i]!); k++) {
      i = (i + 1) % THREAD_PALETTE.length;
    }
    const c = THREAD_PALETTE[i]!;
    given.set(thread, c);
    used.add(c);
    return c;
  };
}
