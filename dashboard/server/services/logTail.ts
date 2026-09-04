/**
 * Tail data/daemon.log, keep a ring buffer of recent lines, broadcast new
 * lines to SSE subscribers.
 *
 * The log format is `<ISO> [level] [tag] message key=val ...` per
 * src/util/log.ts. We parse cheaply here; malformed lines fall through with
 * level=plain and tag=null so the UI can still render them.
 */

import {
  type FSWatcher,
  type Stats,
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch,
} from "node:fs";
import type { LogLine } from "../types.ts";

const RING_CAPACITY = 2000;

type Subscriber = {
  onLine: (line: LogLine) => void;
  onClose: () => void;
};

export class LogTail {
  private path: string;
  private fd: number | null = null;
  private pos = 0;
  private watcher: FSWatcher | null = null;
  private ring: LogLine[] = [];
  private seq = 0;
  private subscribers = new Set<Subscriber>();
  private carry = "";
  private stopped = false;

  constructor(path: string) {
    this.path = path;
  }

  start(): void {
    if (!existsSync(this.path)) {
      // Create empty file so watcher has something to attach to.
      closeSync(openSync(this.path, "a"));
    }
    this.openFromTail();
    this.watcher = watch(this.path, { persistent: false }, (event) => {
      if (this.stopped) return;
      if (event === "rename") {
        // File was rotated/replaced. Reopen.
        this.reopen();
        return;
      }
      this.drain();
    });
    // Polling safety net: fs.watch on macOS is flaky over network-ish FSes.
    const poll = setInterval(() => {
      if (this.stopped) return;
      this.drain();
    }, 1000);
    (poll as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
    for (const s of this.subscribers) {
      try {
        s.onClose();
      } catch {}
    }
    this.subscribers.clear();
  }

  snapshot(limit = 500): LogLine[] {
    return this.ring.slice(-limit);
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private openFromTail(): void {
    const stat = statSync(this.path);
    this.fd = openSync(this.path, "r");
    // Seed the ring with the tail of the file (last 256KB is enough for ~500 lines).
    const seedSize = Math.min(stat.size, 256 * 1024);
    const seedPos = stat.size - seedSize;
    if (seedSize > 0) {
      const buf = Buffer.alloc(seedSize);
      readSync(this.fd, buf, 0, seedSize, seedPos);
      const text = buf.toString("utf8");
      const firstNl = text.indexOf("\n");
      const clean = seedPos > 0 && firstNl >= 0 ? text.slice(firstNl + 1) : text;
      for (const line of clean.split("\n")) {
        if (line.trim()) this.pushLine(line, /*broadcast*/ false);
      }
    }
    this.pos = stat.size;
  }

  private reopen(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {}
    }
    this.fd = openSync(this.path, "r");
    this.pos = 0;
    this.drain();
  }

  private drain(): void {
    if (this.fd === null) return;
    let stat: Stats;
    try {
      stat = statSync(this.path);
    } catch {
      return;
    }
    if (stat.size < this.pos) {
      // File was truncated — reopen.
      this.reopen();
      return;
    }
    const remaining = stat.size - this.pos;
    if (remaining <= 0) return;
    const buf = Buffer.alloc(Math.min(remaining, 1 << 20));
    const n = readSync(this.fd, buf, 0, buf.length, this.pos);
    this.pos += n;
    const chunk = this.carry + buf.slice(0, n).toString("utf8");
    const lines = chunk.split("\n");
    this.carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) this.pushLine(line, /*broadcast*/ true);
    }
  }

  private pushLine(raw: string, broadcast: boolean): void {
    const line = parseLine(raw, ++this.seq);
    this.ring.push(line);
    if (this.ring.length > RING_CAPACITY) this.ring.splice(0, this.ring.length - RING_CAPACITY);
    if (broadcast) {
      for (const s of this.subscribers) {
        try {
          s.onLine(line);
        } catch {}
      }
    }
  }
}

/**
 * Parse `2026-04-20T18:12:34.567Z [info] [claude] message key=val ...`.
 * Also recognizes bracketless prefixes like `[edmund-harness] starting`.
 */
function parseLine(raw: string, seq: number): LogLine {
  const tsMatch = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s?/);
  const ts = tsMatch ? Date.parse(tsMatch[1]) : Date.now();
  let rest = tsMatch ? raw.slice(tsMatch[0].length) : raw;
  let level: LogLine["level"] = "plain";
  const levelMatch = rest.match(/^\[(debug|info|warn|error)\]\s+/);
  if (levelMatch) {
    level = levelMatch[1] as LogLine["level"];
    rest = rest.slice(levelMatch[0].length);
  }
  let tag: string | null = null;
  const tagMatch = rest.match(/^\[([^\]]+)\]\s+/);
  if (tagMatch) {
    tag = tagMatch[1];
    rest = rest.slice(tagMatch[0].length);
  }
  return { ts, level, tag, text: rest, seq };
}
