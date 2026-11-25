/**
 * Where log files live, and how they are rotated, compressed and removed.
 *
 *   data/daemon.log                     the operational log, today's lines
 *   data/logs/daemon/2026-11-24.log     an earlier day of it (.gz once older)
 *   data/logs/<channel>/<day>.jsonl     one channel, one day (.gz once older)
 *   data/logs/archive/                  what predates rotation; never removed here
 *
 * Days are UTC, like the timestamps in the lines, so a file's name and its
 * contents agree and no clock change can put a line in the wrong day.
 *
 * Until 2026-11-25 nothing was ever rotated: daemon.log held every line since
 * the first boot and reached 1.2 GB, 1.06 GB of it one repeated line from one
 * night. The weekly review read the whole file into memory to count a week.
 */
import {
  appendFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Channel } from "./log-channels.ts";

const DAY_MS = 86_400_000;

export function utcDay(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day `days` before `day` (after it, for a negative number). */
export function dayBefore(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS);
}

function logsRoot(dataDir: string): string {
  return join(dataDir, "logs");
}

export function channelDir(dataDir: string, channel: Channel): string {
  return join(logsRoot(dataDir), channel);
}

export function channelFile(dataDir: string, channel: Channel, day: string): string {
  return join(channelDir(dataDir, channel), `${day}.jsonl`);
}

/** Earlier days of an operational log: `daemon.log` rotates into `logs/daemon/`. */
function rotatedDir(dataDir: string, opsFile: string): string {
  return join(logsRoot(dataDir), basename(opsFile).replace(/\.log$/, ""));
}

export function archiveDir(dataDir: string): string {
  return join(logsRoot(dataDir), "archive");
}

const ROTATING = /^\.rotating-.*\.log$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.(log|jsonl)(\.gz)?$/;

type DayFile = { path: string; day: string; part: number; gz: boolean; bytes: number };

/** A directory's day files, oldest first; parts of one day in the order they were written. */
export function dayFiles(dir: string): DayFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: DayFile[] = [];
  for (const name of names) {
    const m = DAY_FILE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      continue;
    }
    out.push({ path, day: m[1]!, part: Number(m[2] ?? 0), gz: Boolean(m[4]), bytes });
  }
  return out.sort((a, b) => (a.day === b.day ? a.part - b.part : a.day < b.day ? -1 : 1));
}

function readMaybeGz(file: DayFile): string {
  const raw = readFileSync(file.path);
  return file.gz ? Buffer.from(Bun.gunzipSync(raw)).toString("utf8") : raw.toString("utf8");
}

/** The day a log line belongs to, from the timestamp it starts with. */
function dayAt(buf: Buffer, pos: number): string | null {
  if (pos + 11 > buf.length) return null;
  // 2026-11-25T
  if (buf[pos + 4] !== 45 || buf[pos + 7] !== 45 || buf[pos + 10] !== 84) return null;
  const day = buf.toString("latin1", pos, pos + 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Move an operational log aside when what it holds began on an earlier day.
 * The move is one rename, so a process appending to the path simply starts
 * the new file; `settleRotations` then files the old one by day. Returns the
 * path it was moved to, or null when there was nothing to move.
 */
export function rotateOpsLog(opsPath: string, dataDir: string, today = utcDay()): string | null {
  let size = 0;
  try {
    size = statSync(opsPath).size;
  } catch {
    return null;
  }
  if (size === 0) return null;
  if (firstDayOf(opsPath) === today) return null;
  const dir = rotatedDir(dataDir, opsPath);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `.rotating-${Date.now()}-${process.pid}.log`);
  try {
    renameSync(opsPath, target);
  } catch {
    return null;
  }
  return target;
}

/** The day of a file's first line, read from its first bytes: the file may be very large. */
function firstDayOf(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(16);
      readSync(fd, head, 0, 16, 0);
      return dayAt(head, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** A name in `dir` for `day` that nothing has yet: `<day>.log`, then `<day>.1.log`. */
function freeDayPath(dir: string, day: string): string {
  for (let part = 0; ; part++) {
    const name = part === 0 ? `${day}.log` : `${day}.${part}.log`;
    if (!existsSync(join(dir, name)) && !existsSync(join(dir, `${name}.gz`))) {
      return join(dir, name);
    }
  }
}

export type SettleReport = { files: number; days: number; archivedBytes: number };

/**
 * File every log that `rotateOpsLog` moved aside: each day's lines into that
 * day's file, and days older than `keepFromDay` into one file under
 * `logs/archive/`, which nothing here ever removes. A log that covers one day
 * is renamed and not read. A crash part-way leaves the moved file in place
 * and its half-written pieces in a folder this deletes before starting again.
 */
export async function settleRotations(
  dataDir: string,
  opsFile: string,
  keepFromDay: string,
): Promise<SettleReport> {
  const dir = rotatedDir(dataDir, opsFile);
  const report: SettleReport = { files: 0, days: 0, archivedBytes: 0 };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => ROTATING.test(n));
  } catch {
    return report;
  }
  for (const name of names.sort()) {
    const src = join(dir, name);
    const work = join(dir, `.split-${name}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const fallbackDay = utcDay(statSync(src).mtimeMs);
    const seen = new Set<string>();
    const archived: string[] = [];
    const write = (day: string, chunk: Buffer) => {
      if (chunk.length === 0) return;
      if (day < keepFromDay) {
        if (!archived.includes(day)) archived.push(day);
        report.archivedBytes += chunk.length;
        appendFileSync(join(work, "archive.log"), chunk);
        return;
      }
      seen.add(day);
      appendFileSync(join(work, `${day}.log`), chunk);
    };

    let day = "";
    let carry: Buffer = Buffer.alloc(0);
    for await (const piece of createReadStream(src, { highWaterMark: 4 << 20 })) {
      const chunk = piece as Buffer;
      let buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const lastNewline = buf.lastIndexOf(10);
      if (lastNewline < 0) {
        carry = buf;
        continue;
      }
      carry = Buffer.from(buf.subarray(lastNewline + 1));
      buf = buf.subarray(0, lastNewline + 1);
      // Lines are in time order: when the first and last line of this piece
      // are the same day, so is everything between them.
      const lastLine = buf.lastIndexOf(10, buf.length - 2) + 1;
      const first = dayAt(buf, 0);
      if (first && first === dayAt(buf, lastLine) && (day === "" || day === first)) {
        day = first;
        write(day, buf);
        continue;
      }
      let runStart = 0;
      let pos = 0;
      while (pos < buf.length) {
        const lineDay = dayAt(buf, pos) ?? (day || fallbackDay);
        if (lineDay !== day) {
          if (day) write(day, buf.subarray(runStart, pos));
          runStart = pos;
          day = lineDay;
        }
        const newline = buf.indexOf(10, pos);
        pos = newline < 0 ? buf.length : newline + 1;
      }
      write(day || fallbackDay, buf.subarray(runStart));
    }
    if (carry.length > 0) write(day || fallbackDay, carry);

    for (const d of [...seen].sort()) {
      renameSync(join(work, `${d}.log`), freeDayPath(dir, d));
      report.days++;
    }
    if (archived.length > 0) {
      archived.sort();
      const out = archiveDir(dataDir);
      mkdirSync(out, { recursive: true });
      const stem = `${basename(opsFile).replace(/\.log$/, "")}-${archived[0]}_to_${archived[archived.length - 1]}`;
      let target = join(out, `${stem}.log`);
      for (let n = 1; existsSync(target) || existsSync(`${target}.gz`); n++) {
        target = join(out, `${stem}.${n}.log`);
      }
      renameSync(join(work, "archive.log"), target);
    }
    rmSync(work, { recursive: true, force: true });
    unlinkSync(src);
    report.files++;
  }
  return report;
}

/**
 * The operational log's lines from `sinceMs` on, oldest first: the rotated
 * days that can hold them, then today's file. For readers that used to read
 * the whole of daemon.log to look at its last week.
 */
export function readOpsLog(dataDir: string, sinceMs: number, opsFile = "daemon.log"): string {
  const sinceDay = utcDay(sinceMs);
  const parts: string[] = [];
  for (const file of dayFiles(rotatedDir(dataDir, opsFile))) {
    if (file.day < sinceDay) continue;
    try {
      parts.push(readMaybeGz(file));
    } catch {
      // A day that cannot be read is a gap, not a reason to read nothing.
    }
  }
  try {
    parts.push(readFileSync(join(dataDir, opsFile), "utf8"));
  } catch {}
  return parts.join("");
}

export type ChannelRecord = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  ch: Channel;
  tag: string;
  msg: string;
  proc: string;
  pid: number;
  /** The writing process's count of its records: the order within one millisecond. */
  seq?: number;
  session?: string;
  turn?: string;
  fields?: Record<string, unknown>;
};

/** One channel's records between two instants, oldest first. Unreadable lines are skipped. */
export function readChannel(
  dataDir: string,
  channel: Channel,
  sinceMs: number,
  untilMs: number = Number.POSITIVE_INFINITY,
): ChannelRecord[] {
  const sinceDay = utcDay(sinceMs);
  const untilDay = Number.isFinite(untilMs) ? utcDay(untilMs) : "9999-12-31";
  const out: ChannelRecord[] = [];
  for (const file of dayFiles(channelDir(dataDir, channel))) {
    if (file.day < sinceDay || file.day > untilDay) continue;
    let text: string;
    try {
      text = readMaybeGz(file);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as ChannelRecord;
        const at = Date.parse(record.ts);
        if (at >= sinceMs && at <= untilMs) out.push(record);
      } catch {}
    }
  }
  return out;
}

export type LogPolicy = {
  /** Days a channel file or a rotated day of the operational log is kept. */
  retentionDays: number;
  /** Days a file stays plain text before it is compressed. */
  compressAfterDays: number;
  /** Everything under logs/ except the archive is kept below this, oldest days going first. */
  maxTotalMb: number;
  /** A log some other program appends to (launchd, a tunnel) is archived and emptied past this size. */
  captureMaxMb: number;
};

export const DEFAULT_LOG_POLICY: LogPolicy = {
  retentionDays: 30,
  compressAfterDays: 2,
  maxTotalMb: 2048,
  captureMaxMb: 20,
};

export type JanitorReport = {
  settled: SettleReport;
  compressed: number;
  removed: number;
  removedBytes: number;
  captured: string[];
  errors: string[];
};

async function gzip(path: string): Promise<boolean> {
  const proc = Bun.spawn(["gzip", "-f", path], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

/** Every folder under logs/ that holds day files: the channels and the rotated operational logs. */
function dayDirs(dataDir: string): string[] {
  try {
    return readdirSync(logsRoot(dataDir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "archive")
      .map((e) => join(logsRoot(dataDir), e.name));
  } catch {
    return [];
  }
}

/**
 * The operational logs this process's sink does not own: whatever launchd or
 * a tunnel script appends to in the data folder. They cannot be renamed while
 * the writer holds them open, so a large one is copied into the archive and
 * emptied in place. launchd opens these for append (measured 2026-11-25:
 * `lsof +fg` shows AP), so the writer carries on at the new end.
 */
async function trimCaptures(
  dataDir: string,
  ownedByASink: string[],
  maxBytes: number,
  report: JanitorReport,
): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".log") || ownedByASink.includes(name)) continue;
    const path = join(dataDir, name);
    let size = 0;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size <= maxBytes) continue;
    const out = archiveDir(dataDir);
    mkdirSync(out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(out, `${name.replace(/\.log$/, "")}-until-${stamp}.log.gz`);
    const proc = Bun.spawn(["gzip", "-c", path], { stdout: Bun.file(target), stderr: "ignore" });
    if ((await proc.exited) !== 0) {
      report.errors.push(`could not archive ${name}`);
      rmSync(target, { force: true });
      continue;
    }
    try {
      truncateSync(path, 0);
      report.captured.push(name);
    } catch (err) {
      report.errors.push(`could not empty ${name}: ${(err as Error).message}`);
    }
  }
}

/**
 * Keep the logs within their policy. Safe to run while every process is
 * writing: it touches only days that are over, and today's files are left
 * alone. `opsFiles` are the operational logs whose rotated days are filed
 * here (`daemon.log`, `dashboard.log`).
 */
export async function runLogJanitor(
  dataDir: string,
  policy: LogPolicy = DEFAULT_LOG_POLICY,
  opsFiles: string[] = ["daemon.log", "dashboard.log"],
  now: number = Date.now(),
): Promise<JanitorReport> {
  const today = utcDay(now);
  const report: JanitorReport = {
    settled: { files: 0, days: 0, archivedBytes: 0 },
    compressed: 0,
    removed: 0,
    removedBytes: 0,
    captured: [],
    errors: [],
  };
  const keepFrom = dayBefore(today, policy.retentionDays);

  for (const opsFile of opsFiles) {
    try {
      const settled = await settleRotations(dataDir, opsFile, keepFrom);
      report.settled.files += settled.files;
      report.settled.days += settled.days;
      report.settled.archivedBytes += settled.archivedBytes;
    } catch (err) {
      report.errors.push(`could not file ${opsFile}: ${(err as Error).message}`);
    }
  }

  // Past retention: gone. Past the plain-text window: compressed.
  const compressBefore = dayBefore(today, policy.compressAfterDays);
  for (const dir of dayDirs(dataDir)) {
    for (const file of dayFiles(dir)) {
      if (file.day >= today) continue;
      if (file.day < keepFrom) {
        try {
          unlinkSync(file.path);
          report.removed++;
          report.removedBytes += file.bytes;
        } catch (err) {
          report.errors.push(`could not remove ${file.path}: ${(err as Error).message}`);
        }
        continue;
      }
      if (!file.gz && file.day < compressBefore) {
        if (await gzip(file.path)) report.compressed++;
        else report.errors.push(`could not compress ${file.path}`);
      }
    }
  }

  // The archive is kept, and is small once compressed.
  try {
    for (const name of readdirSync(archiveDir(dataDir))) {
      if (!name.endsWith(".log")) continue;
      if (await gzip(join(archiveDir(dataDir), name))) report.compressed++;
    }
  } catch {}

  // Over the cap: whole days go, oldest first, across every channel at once.
  const all = dayDirs(dataDir).flatMap((dir) => dayFiles(dir));
  let total = all.reduce((sum, f) => sum + f.bytes, 0);
  const cap = policy.maxTotalMb * 1024 * 1024;
  if (total > cap) {
    for (const file of all.filter((f) => f.day < today).sort((a, b) => (a.day < b.day ? -1 : 1))) {
      if (total <= cap) break;
      try {
        unlinkSync(file.path);
        total -= file.bytes;
        report.removed++;
        report.removedBytes += file.bytes;
      } catch {}
    }
  }

  await trimCaptures(dataDir, opsFiles, policy.captureMaxMb * 1024 * 1024, report);
  return report;
}
