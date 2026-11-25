/**
 * Runtime crashes the daemon cannot log for itself.
 *
 * When the runtime segfaults it writes a report to stderr and the process is
 * gone. launchd starts the daemon again and nothing in daemon.log says why:
 * 13 such crashes between 2026-09-03 and 2026-11-16 were found only by
 * reading the launchd stderr file by hand, weeks later. At boot this reads
 * what that file gained since the previous boot and says so.
 */
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";

export type RuntimeCrash = {
  /** e.g. "Bun v1.3.9". */
  runtime: string;
  /** e.g. "Segmentation fault at address 0x4EEA4000000". */
  panic: string;
  /** How long the crashed process had been up, when the report says. */
  uptimeMs: number | null;
  /** The runtime's own link to the redacted trace. */
  report: string | null;
};

/** A report is a short block. Anything further from its first line than this
 *  belongs to something else. */
const REPORT_LINES = 40;

/**
 * Crash reports of the program named `entry` in a stretch of its stderr.
 *
 * Child processes share that stderr and the model CLI is built on the same
 * runtime, so a crash of theirs lands in the same file. A report names the
 * program it came from on its `Args:` line, and only the daemon's own count.
 */
export function findRuntimeCrashes(stderr: string, entry: string): RuntimeCrash[] {
  const lines = stderr.split("\n");
  const crashes: RuntimeCrash[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(Bun v\d[\w.-]*) \(/.exec(lines[i]!);
    if (!head) continue;
    let ours = false;
    let panic: string | null = null;
    let uptimeMs: number | null = null;
    let report: string | null = null;
    let j = i + 1;
    for (; j < lines.length && j <= i + REPORT_LINES; j++) {
      const line = lines[j]!;
      if (/^Bun v\d/.test(line)) break;
      if (line.startsWith("Args: ")) ours = line.includes(`${entry}"`);
      const elapsed = /^Elapsed: (\d+)ms/.exec(line);
      if (elapsed) uptimeMs = Number(elapsed[1]);
      const panicked = /^panic(?:\([^)]*\))?: (.+)$/.exec(line);
      if (panicked) panic = panicked[1]!.trim();
      const link = /(https:\/\/bun\.report\/\S+)/.exec(line);
      if (link) {
        report = link[1]!;
        break;
      }
    }
    if (ours && panic) crashes.push({ runtime: head[1]!, panic, uptimeMs, report });
    i = j - 1;
  }
  return crashes;
}

type Cursor = { size: number; alertedAtMs: number };

function readCursor(path: string): Cursor | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Cursor>;
    if (typeof raw.size !== "number") return null;
    return {
      size: raw.size,
      alertedAtMs: typeof raw.alertedAtMs === "number" ? raw.alertedAtMs : 0,
    };
  } catch {
    return null;
  }
}

/** Most of stderr one boot reads. A report is under 2 KB; this is slack for
 *  a noisy day between two boots. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

/** A crash loop restarts every half minute. The log gets every crash; the
 *  operator gets one message per this long. */
export const CRASH_ALERT_EVERY_MS = 6 * 3_600_000;

/**
 * What the daemon's stderr gained since the previous boot, read for crash
 * reports. `alert` is true when the operator has not been told recently.
 * The first boot only notes where the file ends: there is no previous boot
 * to speak for, and the file may hold months of old reports.
 */
export function crashesSinceLastBoot(opts: {
  stderrPath: string;
  cursorPath: string;
  entry: string;
  nowMs?: number;
}): { crashes: RuntimeCrash[]; alert: boolean } {
  const now = opts.nowMs ?? Date.now();
  let size: number;
  try {
    size = statSync(opts.stderrPath).size;
  } catch {
    return { crashes: [], alert: false };
  }
  const cursor = readCursor(opts.cursorPath);
  let crashes: RuntimeCrash[] = [];
  if (cursor) {
    // A smaller file was rotated or truncated: all of it is new.
    const from = Math.max(cursor.size <= size ? cursor.size : 0, size - MAX_READ_BYTES);
    if (size > from) {
      const buf = Buffer.alloc(size - from);
      const fd = openSync(opts.stderrPath, "r");
      try {
        readSync(fd, buf, 0, buf.length, from);
      } finally {
        closeSync(fd);
      }
      crashes = findRuntimeCrashes(buf.toString("utf8"), opts.entry);
    }
  }
  const alert = crashes.length > 0 && now - (cursor?.alertedAtMs ?? 0) >= CRASH_ALERT_EVERY_MS;
  try {
    writeFileSync(
      opts.cursorPath,
      JSON.stringify({ size, alertedAtMs: alert ? now : (cursor?.alertedAtMs ?? 0) }),
    );
  } catch {
    // Without a cursor the next boot starts over as a first boot.
  }
  return { crashes, alert };
}

export function describeUptime(ms: number | null): string {
  if (ms === null) return "unknown";
  const minutes = Math.round(ms / 60_000);
  return minutes < 90 ? `${minutes} min` : `${(ms / 3_600_000).toFixed(1)} h`;
}
