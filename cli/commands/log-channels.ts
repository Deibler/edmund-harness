/**
 * `edmund logs <channel>`, `edmund logs channels`, `edmund logs trace`, `edmund logs tidy`.
 *
 * `edmund logs` on its own is the operational log, as before. These read the
 * channel files beside it (src/util/log-channels.ts):
 *
 *   edmund logs channels                       what there is, and how much
 *   edmund logs net-out --since 2h             one channel
 *   edmund logs security -f                    one channel, as it happens
 *   edmund logs errors                         every warning and error, from everywhere
 *   edmund logs trace model_turn_ab12          one turn, across every channel
 *   edmund logs trace sam --at 14:05           one conversation around a time
 *   edmund logs tidy                           compress, expire and archive now
 *
 * The channel goes before the flags: `-f net-out` would read as "-f, with the
 * value net-out".
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config/config.ts";
import { CHANNELS, CHANNEL_NAMES, type Channel, isChannel } from "../../src/util/log-channels.ts";
import {
  type ChannelRecord,
  DEFAULT_LOG_POLICY,
  type LogPolicy,
  archiveDir,
  channelDir,
  channelFile,
  dayFiles,
  readChannel,
  runLogJanitor,
  utcDay,
} from "../../src/util/log-files.ts";
import type { Parsed } from "../args.ts";
import { getString, hasFlag } from "../args.ts";
import { LOGS_DIR, REPO } from "../services/paths.ts";
import { color, fail, info, ok, print, table } from "../ui.ts";

const logsDir = (): string => LOGS_DIR;

export function isLogSubcommand(word: string | undefined): boolean {
  return (
    word !== undefined &&
    (isChannel(word) || ["channels", "list", "trace", "tidy", "errors"].includes(word))
  );
}

export async function logChannelCommand(p: Parsed, sub: string, rest: string[]): Promise<void> {
  if (sub === "channels" || sub === "list") return listChannels();
  if (sub === "trace") return trace(p, rest[0]);
  if (sub === "tidy") return tidy();
  const channel = sub === "errors" ? "error" : sub;
  if (isChannel(channel)) return showChannel(p, channel);
  fail(`no such channel: ${sub}`);
  listChannels();
  process.exit(1);
}

// --- reading the flags -----------------------------------------------------

/** `90s`, `30m`, `2h`, `3d` as milliseconds. */
export function parseSpan(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s"]!;
}

/**
 * `14:05` or `14:05:30` is that time today on this machine's clock, or
 * yesterday when that has not happened yet; anything else is read as a date.
 */
export function parseMoment(text: string, now: number = Date.now()): number | null {
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), 0);
    return at.getTime() > now ? at.getTime() - 86_400_000 : at.getTime();
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// --- printing --------------------------------------------------------------

function fieldText(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "session" || key === "turn" || value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const flat = text.replace(/\s+/g, " ");
    parts.push(`${key}=${flat.length > 160 ? `${flat.slice(0, 160)}…` : flat}`);
  }
  return parts.join(" ");
}

function paintLevel(level: string): string {
  const text = level.toUpperCase().padEnd(5);
  if (level === "error") return color.red(text);
  if (level === "warn") return color.yellow(text);
  return color.dim(text);
}

function shortSession(session: string | undefined): string {
  if (!session) return "-";
  const bare = session.replace(/^imessage:/, "");
  return bare.length > 22 ? `${bare.slice(0, 21)}…` : bare;
}

/** One record on one line. `showChannel` is for a merged view, where records come from several. */
export function formatRecord(record: ChannelRecord, showChannel = false): string {
  const time = color.dim(record.ts.slice(11, 23));
  const where = showChannel
    ? color.cyan(record.ch.padEnd(11))
    : color.cyan((record.tag || "-").padEnd(14));
  const who = color.magenta(shortSession(record.session).padEnd(22));
  const proc = record.proc === "daemon" ? "" : color.dim(`${record.proc} `);
  const tag = showChannel && record.tag ? color.dim(`[${record.tag}] `) : "";
  const fields = fieldText(record.fields);
  const msg = record.msg.replace(/\s*\n\s*/g, " ⏎ ");
  return `${time}  ${paintLevel(record.level)}  ${where}  ${who}  ${proc}${tag}${msg}${fields ? `  ${color.dim(fields)}` : ""}`;
}

type Filters = { levels: Set<string> | null; session: string | null; grep: RegExp | null };

function filtersFrom(p: Parsed): Filters {
  const levels = ["debug", "info", "warn", "error"].filter((l) => hasFlag(p, l));
  const grepRaw = getString(p, "grep", "g");
  let grep: RegExp | null = null;
  if (grepRaw) {
    try {
      grep = new RegExp(grepRaw, "i");
    } catch (err) {
      fail(`bad --grep regex: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  return {
    levels: levels.length > 0 ? new Set(levels) : null,
    session: getString(p, "session", "s")?.toLowerCase() ?? null,
    grep,
  };
}

function passes(record: ChannelRecord, f: Filters): boolean {
  if (f.levels && !f.levels.has(record.level)) return false;
  if (f.session && !(record.session ?? "").toLowerCase().includes(f.session)) return false;
  if (f.grep && !f.grep.test(JSON.stringify(record))) return false;
  return true;
}

// --- one channel -----------------------------------------------------------

async function showChannel(p: Parsed, channel: Channel): Promise<void> {
  const dir = logsDir();
  const filters = filtersFrom(p);
  const json = hasFlag(p, "json");
  const count = Number(getString(p, "lines", "n") ?? "200");
  const sinceText = getString(p, "since");
  const span = sinceText ? parseSpan(sinceText) : null;
  if (sinceText && span === null) {
    fail(`--since takes a span such as 30m, 2h or 3d, not "${sinceText}"`);
    process.exit(1);
  }
  // Without --since, the newest lines: today's and yesterday's files hold them.
  const since = span !== null ? Date.now() - span : Date.now() - 2 * 86_400_000;
  let records = readChannel(dir, channel, since).filter((r) => passes(r, filters));
  if (span === null) records = records.slice(-count);
  const show = (record: ChannelRecord) =>
    print(json ? JSON.stringify(record) : formatRecord(record));
  for (const record of records) show(record);
  if (!hasFlag(p, "follow", "f")) {
    if (records.length === 0) info(`nothing in ${channel} for that`);
    return;
  }

  // Follow: read what is appended to today's file, and move on when the day does.
  let day = utcDay();
  let path = channelFile(dir, channel, day);
  let pos = sizeOf(path);
  let carry = "";
  setInterval(() => {
    const today = utcDay();
    if (today !== day) {
      day = today;
      path = channelFile(dir, channel, day);
      pos = 0;
      carry = "";
    }
    const size = sizeOf(path);
    if (size < pos) pos = 0;
    if (size === pos) return;
    const buf = Buffer.alloc(Math.min(size - pos, 4 << 20));
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    try {
      pos += readSync(fd, buf, 0, buf.length, pos);
    } finally {
      closeSync(fd);
    }
    const lines = (carry + buf.toString("utf8")).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as ChannelRecord;
        if (passes(record, filters)) show(record);
      } catch {}
    }
  }, 500);
  await new Promise(() => {});
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// --- what there is ---------------------------------------------------------

function listChannels(): void {
  const dir = logsDir();
  const today = utcDay();
  const rows: string[][] = [];
  let total = 0;
  for (const channel of CHANNEL_NAMES) {
    const files = dayFiles(channelDir(dir, channel));
    const size = files.reduce((sum, f) => sum + f.bytes, 0);
    total += size;
    const todayBytes = files.filter((f) => f.day === today).reduce((sum, f) => sum + f.bytes, 0);
    rows.push([
      color.cyan(channel),
      files.length ? `${new Set(files.map((f) => f.day)).size}` : color.dim("0"),
      files.length ? bytes(todayBytes) : color.dim("-"),
      files.length ? bytes(size) : color.dim("-"),
      CHANNELS[channel],
    ]);
  }
  table(["channel", "days", "today", "on disk", "what it holds"], rows);
  const archived = folderBytes(archiveDir(dir));
  print();
  const inArchive = archived > 0 ? `, ${bytes(archived)} in the archive` : "";
  print(`${bytes(total)} in channels under ${color.dim(dir)}${inArchive}`);
  print(color.dim("edmund logs <channel> [--since 2h] [-f] [--session NAME] [--grep RE] [--json]"));
}

function folderBytes(dir: string): number {
  try {
    return readdirSync(dir).reduce((sum, name) => sum + sizeOf(resolve(dir, name)), 0);
  } catch {
    return 0;
  }
}

// --- one turn, or one conversation around a moment -------------------------

/** By time; within one millisecond, one process's records in the order it wrote them. */
function inOrder(a: ChannelRecord, b: ChannelRecord): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.pid === b.pid) return (a.seq ?? 0) - (b.seq ?? 0);
  return 0;
}

/** Channels whose records belong to no conversation and still explain one. */
const AMBIENT: Channel[] = ["resource", "system", "error", "security", "net-in"];

/**
 * Everything on record about one turn or one conversation, in the order it
 * happened. `what` is a turn id (as `turn start` logs it, or a scheduled
 * job's id) or part of a conversation's name.
 */
export function collectTrace(
  dir: string,
  what: string,
  opts: { atMs?: number; minutes: number; all: boolean; now?: number },
): { records: ChannelRecord[]; from: number; to: number; turns: string[]; sessions: string[] } {
  const now = opts.now ?? Date.now();
  const wanted = what.toLowerCase();
  const isTurnId = /^(model_turn|job)_/.test(what);
  let from =
    opts.atMs !== undefined ? opts.atMs - opts.minutes * 60_000 : now - opts.minutes * 60_000;
  let to = opts.atMs !== undefined ? opts.atMs + opts.minutes * 60_000 : now;

  const everything = (sinceMs: number, untilMs: number) =>
    CHANNEL_NAMES.flatMap((channel) => readChannel(dir, channel, sinceMs, untilMs));

  if (isTurnId) {
    // A turn is found wherever it is in the last three days, and sets its own window.
    const mine = everything(now - 3 * 86_400_000, now).filter((r) => r.turn === what);
    if (mine.length === 0) return { records: [], from, to, turns: [], sessions: [] };
    const times = mine.map((r) => Date.parse(r.ts));
    from = Math.min(...times) - 2_000;
    to = Math.max(...times) + 2_000;
  }

  const seen = new Set<string>();
  const records: ChannelRecord[] = [];
  for (const record of everything(from, to)) {
    const belongs = isTurnId
      ? record.turn === what
      : (record.session ?? "").toLowerCase().includes(wanted);
    const ambient = !record.session && (opts.all || AMBIENT.includes(record.ch));
    if (!belongs && !ambient) continue;
    // A warning is filed under its own channel and copied to `error`: show it once.
    const key = `${record.pid}|${record.seq ?? record.ts}|${record.tag}|${record.msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  records.sort(inOrder);
  const own = records.filter((r) => r.session);
  return {
    records,
    from,
    to,
    turns: [...new Set(own.map((r) => r.turn).filter((t): t is string => Boolean(t)))],
    sessions: [...new Set(own.map((r) => r.session!))],
  };
}

function trace(p: Parsed, what: string | undefined): void {
  if (!what) {
    fail(
      "usage: edmund logs trace <turn id | part of a conversation's name> [--at 14:05] [--minutes 10] [--all]",
    );
    process.exit(1);
  }
  const atText = getString(p, "at");
  const atMs = atText ? parseMoment(atText) : undefined;
  if (atText && atMs === null) {
    fail(`--at takes a time such as 14:05 or a date, not "${atText}"`);
    process.exit(1);
  }
  const minutes = Number(getString(p, "minutes", "m") ?? (atText ? "5" : "10"));
  const result = collectTrace(logsDir(), what, {
    atMs: atMs ?? undefined,
    minutes,
    all: hasFlag(p, "all", "a"),
  });
  if (result.records.length === 0) {
    info(`nothing on record for "${what}" in that window`);
    return;
  }
  const json = hasFlag(p, "json");
  if (!json) {
    const perChannel = new Map<string, number>();
    for (const r of result.records) perChannel.set(r.ch, (perChannel.get(r.ch) ?? 0) + 1);
    print(
      color.bold(
        `${new Date(result.from).toISOString().slice(0, 19)}Z to ${new Date(result.to).toISOString().slice(11, 19)}Z`,
      ),
    );
    if (result.sessions.length) print(`conversation  ${result.sessions.join(", ")}`);
    if (result.turns.length) print(`turns         ${result.turns.join(", ")}`);
    print(`records       ${[...perChannel].map(([channel, n]) => `${channel} ${n}`).join(", ")}`);
    print();
  }
  for (const record of result.records) {
    print(json ? JSON.stringify(record) : formatRecord(record, true));
  }
}

// --- upkeep ----------------------------------------------------------------

async function tidy(): Promise<void> {
  let policy: LogPolicy = DEFAULT_LOG_POLICY;
  try {
    const config = loadConfig(process.env.EDMUND_CONFIG_PATH ?? resolve(REPO, "config.toml"));
    policy = {
      retentionDays: config.logs.retention_days,
      compressAfterDays: config.logs.compress_after_days,
      maxTotalMb: config.logs.max_total_mb,
      captureMaxMb: config.logs.capture_max_mb,
    };
  } catch {
    // No config: the defaults.
  }
  const report = await runLogJanitor(logsDir(), policy);
  ok(
    `filed ${report.settled.files} rotated log(s) into ${report.settled.days} day(s), compressed ${report.compressed}, removed ${report.removed} (${bytes(report.removedBytes)})`,
  );
  if (report.settled.archivedBytes > 0) {
    info(
      `${bytes(report.settled.archivedBytes)} older than ${policy.retentionDays} days went to the archive`,
    );
  }
  for (const name of report.captured) info(`archived and emptied ${name}`);
  for (const error of report.errors) fail(error);
}
