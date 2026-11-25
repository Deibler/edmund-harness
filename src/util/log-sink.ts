/**
 * Where log lines go once a process has a data folder to write to.
 *
 * Every line goes two places. The operational log (`data/daemon.log`) gets
 * the line as text, in the order things happened; that is what `edmund logs`
 * follows. A channel file (`data/logs/<channel>/<day>.jsonl`) gets the same
 * event as a JSON record with its fields intact and the conversation and turn
 * it belongs to, so one subject can be read alone and one turn can be traced
 * across all of them (`edmund logs trace`). Channel-only records, such as
 * every outbound request, go to their channel and not to the operational log.
 *
 * Installed by main.ts at boot, and by each subprocess that inherits
 * EDMUND_DATA_DIR (MCP servers, agent and background runners), which append to
 * the same files. Hooks `console.*` directly: Bun's console bypasses
 * `process.stdout.write`, so stream-level hooks miss it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { format } from "node:util";
import { type Channel, channelForTag, isSecurityEvent } from "./log-channels.ts";
import { resolveLogContext, setProcessLogContext } from "./log-context.ts";
import {
  DEFAULT_LOG_POLICY,
  channelFile,
  dayBefore,
  rotateOpsLog,
  settleRotations,
  utcDay,
} from "./log-files.ts";
import { instrumentProcess } from "./log-instrument.ts";

export type Level = "debug" | "info" | "warn" | "error";
type ConsoleLevel = "log" | "info" | "warn" | "error";

export type SinkOptions = {
  /**
   * Also print each line on the terminal. "tty" prints only when there is one:
   * under launchd the daemon's output is a file, and printing there wrote
   * every line a second time (launchd.err.log reached 871 MB, 825 MB of it
   * lines daemon.log already had).
   */
  echo?: boolean | "tty";
  /** This process owns the operational log file and moves it aside when the day changes. */
  rotate?: boolean;
  /** The conversation this whole process serves, for records that do not name one. */
  session?: string;
  /** How many days of a rotated log stay as day files; older lines go to the archive. */
  retentionDays?: number;
  /**
   * Record this process's outbound requests, child processes and fatal
   * exception (log-instrument.ts). On unless a test turns it off: the hooks
   * replace process-wide functions and stay for the life of the process.
   */
  instrument?: boolean;
};

export type LogEntry = {
  level: Level;
  tag: string;
  msg: string;
  fields?: Record<string, unknown>;
  /** The line for the operational log, without its timestamp; null for a channel-only record. */
  text: string | null;
  /** The channel, when it is not the tag's own. */
  channel?: Channel;
  /** Which console method the operational log's `[level]` column shows. */
  consoleLevel?: ConsoleLevel;
};

type Sink = {
  dataDir: string;
  /** Null for a process whose printed lines something else already keeps. */
  opsPath: string | null;
  prefix: string;
  proc: string;
  echo: boolean;
  rotate: boolean;
  retentionDays: number;
  day: string;
};

let sink: Sink | null = null;
/** Counts this process's records, so two written in the same millisecond keep their order. */
let sequence = 0;
const originals: Partial<Record<ConsoleLevel, (...args: unknown[]) => void>> = {};
const madeDirs = new Set<string>();

/** True once this process writes its logs to files. */
export function sinkInstalled(): boolean {
  return sink !== null;
}

/** `mcp[dm:+1555…] ` is the mcp process; `[dash] ` the dashboard; no prefix, whoever owns the file. */
function procName(prefix: string, filename: string): string {
  const sub = /^([a-z-]+)\[/.exec(prefix);
  if (sub) return sub[1]!;
  return basename(filename).replace(/\.log$/, "");
}

export function installLogSink(
  dataDir: string,
  prefix = "",
  filename = "daemon.log",
  options: SinkOptions = {},
): string {
  const path = join(dataDir, filename);
  mkdirSync(dirname(path), { recursive: true });
  const today = utcDay();
  sink = {
    dataDir,
    opsPath: path,
    prefix,
    proc: procName(prefix, filename),
    echo: options.echo === "tty" ? Boolean(process.stdout.isTTY) : (options.echo ?? true),
    rotate: options.rotate ?? false,
    retentionDays: options.retentionDays ?? DEFAULT_LOG_POLICY.retentionDays,
    day: today,
  };
  madeDirs.clear();
  setProcessLogContext(options.session ? { session: options.session } : {});
  if (sink.rotate) rotate(sink, today);
  hookConsole();
  if (options.instrument ?? true) instrumentProcess(sinkWrite);
  return path;
}

/**
 * The channels and the hooks without an operational log file: for a process
 * launchd already keeps the output of (the public router), where a second
 * file would hold every line twice. Its lines are printed as before and
 * filed under their channels.
 */
export function installChannelSink(
  dataDir: string,
  proc: string,
  options: Pick<SinkOptions, "session" | "instrument"> = {},
): void {
  sink = {
    dataDir,
    opsPath: null,
    prefix: "",
    proc,
    echo: true,
    rotate: false,
    retentionDays: DEFAULT_LOG_POLICY.retentionDays,
    day: utcDay(),
  };
  madeDirs.clear();
  setProcessLogContext(options.session ? { session: options.session } : {});
  hookConsole();
  if (options.instrument ?? true) instrumentProcess(sinkWrite);
}

function hookConsole(): void {
  if (Object.keys(originals).length === 0) {
    for (const level of ["log", "info", "warn", "error"] as const) {
      const original = console[level].bind(console) as (...args: unknown[]) => void;
      originals[level] = original;
      console[level] = (...args: unknown[]) => {
        if (!sink) {
          original(...args);
          return;
        }
        const text = format(...args);
        const { tag, body } = splitTag(text);
        sinkWrite({
          level: level === "log" ? "info" : level,
          consoleLevel: level,
          tag,
          msg: body,
          text,
        });
      };
    }
  }
}

/** Put the console back. For tests, which install a sink over a temporary folder. */
export function uninstallLogSink(): void {
  sink = null;
  setProcessLogContext({});
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = originals[level];
    if (original) console[level] = original as typeof console.log;
    delete originals[level];
  }
  flows.clear();
}

/**
 * Install the log sink using EDMUND_DATA_DIR from the environment. Used
 * by subprocesses (MCP server, agent-runner) that inherit env from the
 * parent daemon. Silent no-op if the env var isn't set — safe to call
 * unconditionally at entry.
 *
 * The prefix tags lines so you can tell which subprocess wrote them in
 * the shared file (e.g. `mcp[+17175551212] ` or `agent[abc123] `).
 */
export function installLogSinkFromEnv(prefix = "", options: SinkOptions = {}): string | null {
  const dataDir = process.env.EDMUND_DATA_DIR;
  if (!dataDir) return null;
  return installLogSink(resolve(dataDir), prefix, "daemon.log", options);
}

function splitTag(text: string): { tag: string; body: string } {
  const m = /^\[([A-Za-z0-9_:./-]+)\]\s?/.exec(text);
  return m ? { tag: m[1]!, body: text.slice(m[0].length) } : { tag: "", body: text };
}

function rotate(s: Sink, today: string): void {
  s.day = today;
  const opsPath = s.opsPath;
  if (!opsPath || !rotateOpsLog(opsPath, s.dataDir, today)) return;
  void settleRotations(s.dataDir, basename(opsPath), dayBefore(today, s.retentionDays)).catch(
    () => {
      // The moved file stays where it is and the janitor files it later.
    },
  );
}

// --- flood guard -----------------------------------------------------------
//
// One bug writes one line, quickly. On 2026-11-01 a scheduler loop wrote the
// same line 7.7 million times in 28 minutes (1.9 GB across two files); on
// 2026-11-17 a reconnect loop wrote one 4,290 times in a minute. Three months
// of ordinary operation peak at 31 lines of one shape in ten seconds. So a
// shape gets 200 lines per ten seconds; past that the rest are counted, and
// while it keeps coming it gets 5 per ten seconds and one line saying how many
// were dropped. Nothing about a quiet system changes.

const WINDOW_MS = 10_000;
const BURST = 200;
const WHILE_FLOODING = 5;

type Flow = {
  windowStart: number;
  count: number;
  flooding: boolean;
  suppressed: number;
  tag: string;
  sample: string;
  channel: Channel;
};
const flows = new Map<string, Flow>();
let floodTimer: ReturnType<typeof setInterval> | null = null;

function shapeOf(msg: string): string {
  return msg.slice(0, 96).replace(/\d+/g, "N").slice(0, 48);
}

function suppressionNotice(flow: Flow, ms: number): LogEntry {
  const text = `[log] suppressed ${flow.suppressed} more lines in ${Math.max(1, Math.round(ms / 1000))}s like: [${flow.tag}] ${flow.sample}`;
  return {
    level: "warn",
    tag: "log",
    msg: text.slice("[log] ".length),
    text,
    fields: { suppressed: flow.suppressed, like_tag: flow.tag, like_channel: flow.channel },
  };
}

/** Whether this line is written, and the notice owed for lines dropped before it. */
function floodCheck(
  key: string,
  now: number,
  entry: LogEntry,
  channel: Channel,
): { pass: boolean; notice: LogEntry | null } {
  let flow = flows.get(key);
  if (!flow) {
    if (flows.size > 5_000) {
      for (const [k, f] of flows) if (now - f.windowStart > 6 * WINDOW_MS) flows.delete(k);
    }
    flow = {
      windowStart: now,
      count: 0,
      flooding: false,
      suppressed: 0,
      tag: entry.tag,
      sample: entry.msg.slice(0, 120),
      channel,
    };
    flows.set(key, flow);
  }
  let notice: LogEntry | null = null;
  if (now - flow.windowStart >= WINDOW_MS) {
    if (flow.suppressed > 0) notice = suppressionNotice(flow, now - flow.windowStart);
    flow.flooding = flow.count > (flow.flooding ? WHILE_FLOODING : BURST);
    flow.windowStart = now;
    flow.count = 0;
    flow.suppressed = 0;
  }
  flow.count++;
  if (flow.count <= (flow.flooding ? WHILE_FLOODING : BURST)) return { pass: true, notice };
  flow.suppressed++;
  // A flood that stops has nothing left to trigger its last notice; a timer does.
  if (!floodTimer) {
    floodTimer = setInterval(flushSuppressed, WINDOW_MS);
    floodTimer.unref?.();
  }
  return { pass: false, notice };
}

function flushSuppressed(): void {
  const s = sink;
  const now = Date.now();
  let pending = false;
  for (const flow of flows.values()) {
    if (flow.suppressed === 0) continue;
    if (now - flow.windowStart < WINDOW_MS) {
      pending = true;
      continue;
    }
    if (s) writeOne(s, now, suppressionNotice(flow, now - flow.windowStart), "system");
    flow.flooding = flow.count > (flow.flooding ? WHILE_FLOODING : BURST);
    flow.windowStart = now;
    flow.count = 0;
    flow.suppressed = 0;
  }
  if (!pending && floodTimer) {
    clearInterval(floodTimer);
    floodTimer = null;
  }
}

// --- writing ---------------------------------------------------------------

/** Write one event: to the operational log when it has a text line, and to its channel. */
export function sinkWrite(entry: LogEntry): void {
  const s = sink;
  if (!s) return;
  const now = Date.now();
  const channel = entry.channel ?? channelForTag(entry.tag);
  const { pass, notice } = floodCheck(
    `${channel}|${entry.tag}|${shapeOf(entry.msg)}`,
    now,
    entry,
    channel,
  );
  if (notice) writeOne(s, now, notice, "system");
  if (pass) writeOne(s, now, entry, channel);
}

function writeOne(s: Sink, now: number, entry: LogEntry, channel: Channel): void {
  const iso = new Date(now).toISOString();
  const day = iso.slice(0, 10);
  if (s.rotate && day !== s.day) rotate(s, day);

  if (entry.text !== null) {
    const consoleLevel: ConsoleLevel =
      entry.consoleLevel ??
      (entry.level === "warn" ? "warn" : entry.level === "error" ? "error" : "log");
    let written = false;
    if (s.opsPath) {
      try {
        appendFileSync(s.opsPath, `${iso} [${consoleLevel}] ${s.prefix}${entry.text}\n`);
        written = true;
      } catch {}
    }
    // A line that could not reach the file is printed rather than lost.
    if (s.echo || !written) originals[consoleLevel]?.(entry.text);
  }

  try {
    const named = sessionIn(entry.fields) ?? sessionInText(entry.msg);
    const context = resolveLogContext(named);
    const record = {
      ts: iso,
      level: entry.level,
      ch: channel,
      tag: entry.tag,
      msg: entry.msg.length > 8_000 ? `${entry.msg.slice(0, 8_000)}…` : entry.msg,
      proc: s.proc,
      pid: process.pid,
      seq: ++sequence,
      ...(context.session ? { session: context.session } : {}),
      ...(context.turn ? { turn: context.turn } : {}),
      ...(entry.fields ? { fields: cleanFields(entry.fields) } : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    appendTo(s, channel, day, line);
    if ((entry.level === "warn" || entry.level === "error") && channel !== "error") {
      appendTo(s, "error", day, line);
    }
    if (channel !== "security" && isSecurityEvent(entry.msg)) appendTo(s, "security", day, line);
  } catch {
    // A record that cannot be written must not take the caller down with it.
  }
}

function appendTo(s: Sink, channel: Channel, day: string, line: string): void {
  const path = channelFile(s.dataDir, channel, day);
  const dir = dirname(path);
  if (!madeDirs.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    madeDirs.add(dir);
  }
  try {
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // The folder was removed under us (a cleanup, a test): make it and try once more.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(path, line, { mode: 0o600 });
  }
}

function sessionIn(fields: Record<string, unknown> | undefined): string | undefined {
  const value = fields?.session ?? fields?.sessionKey;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `session=dm:+1555…` in a line that was printed, not passed as fields. */
function sessionInText(msg: string): string | undefined {
  const m = /(?:^|\s)session=(?:"([^"]+)"|(\S+))/.exec(msg);
  return m ? (m[1] ?? m[2]) : undefined;
}

const SECRET_FIELD = /(^|[_-])(api_?key|key|token|secret|password|passwd|authorization|cookie)$/i;
const MAX_FIELD_CHARS = 2_000;

/** Whether a field holds a credential: named like one, and a string that is not a session key or a quantity. */
export function isSecretField(key: string, value: unknown): boolean {
  if (typeof value !== "string" || !SECRET_FIELD.test(key)) return false;
  if (/^(imessage|sms|mirror|agent|grok|dm|group):/.test(value)) return false;
  return !/^-?\d+(\.\d+)?\s?[a-zA-Z%]{0,3}$/.test(value);
}

function cleanFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (isSecretField(key, value)) {
      out[key] = "***";
    } else if (typeof value === "string") {
      out[key] = value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
    } else if (value instanceof Error) {
      out[key] = { message: value.message, stack: value.stack };
    } else if (typeof value === "bigint") {
      out[key] = value.toString();
    } else if (value !== null && typeof value === "object") {
      try {
        const json = JSON.stringify(value);
        out[key] =
          json.length > MAX_FIELD_CHARS ? `${json.slice(0, MAX_FIELD_CHARS)}…` : JSON.parse(json);
      } catch {
        out[key] = String(value);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}
