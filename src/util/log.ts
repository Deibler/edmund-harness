/**
 * Structured logger with DEBUG gating.
 *
 * A line is `[tag] message key=val key=val ...`, greppable
 * (`rg '\[tool\]'`) and easy to scan. In a process that logs to files
 * (log-sink.ts) it goes to logs/daemon.log as that text and to the tag's
 * channel under logs/ as a record with the fields intact; anywhere
 * else it is printed.
 *
 * `log.event` writes to a channel only: for things worth having on record
 * that would bury the operational log, such as every outbound request.
 *
 * DEBUG is on when EDMUND_LOG_LEVEL=debug OR DEBUG=1. When off,
 * `log.debug(...)` is a no-op. Turn it on at boot with
 *   EDMUND_LOG_LEVEL=debug bun src/main.ts
 * or persistently via the launchd plist / service.sh.
 */

import type { Channel } from "./log-channels.ts";
import { type Level, isSecretField, sinkInstalled, sinkWrite } from "./log-sink.ts";

export const DEBUG =
  process.env.EDMUND_LOG_LEVEL === "debug" ||
  process.env.DEBUG === "1" ||
  process.env.DEBUG === "true";

export type Fields = Record<string, unknown>;

const MAX_VALUE_LEN = 240;

function fmtValue(key: string, v: unknown): string {
  // A field is hidden when it is named like a credential and holds one. The
  // name alone used to decide, which hid every `tokens=` count ever logged
  // (25,510 lines by 2026-11-25) and the session in `key=imessage:…`.
  if (isSecretField(key, v)) return "***";
  if (v === null) return "null";
  if (v === undefined) return "";
  if (typeof v === "string") {
    // Reader convenience: keys that carry a session identifier get
    // automatically shortened so log lines stay readable.
    if ((key === "session" || key === "sessionKey") && v.startsWith("imessage:")) {
      return shortSession(v);
    }
    const clean = v.replace(/[\r\n]+/g, " ");
    return clean.length > MAX_VALUE_LEN ? `${clean.slice(0, MAX_VALUE_LEN)}…` : clean;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN)}…` : s;
  } catch {
    return String(v);
  }
}

function fmtFields(f?: Fields): string {
  if (!f) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    const formatted = fmtValue(k, v);
    const quoted = needsQuote(formatted) ? `"${formatted.replace(/"/g, '\\"')}"` : formatted;
    parts.push(`${k}=${quoted}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function needsQuote(s: string): boolean {
  return s.length === 0 || /[\s"=]/.test(s);
}

function emit(level: Level, tag: string, msg: string, fields: Fields | undefined): void {
  const text = `[${tag}] ${level === "debug" ? "[debug] " : ""}${msg}${fmtFields(fields)}`;
  if (sinkInstalled()) {
    sinkWrite({ level, tag, msg, fields, text });
    return;
  }
  if (level === "warn") console.warn(text);
  else if (level === "error") console.error(text);
  else console.log(text);
}

export const log = {
  info(tag: string, msg: string, fields?: Fields): void {
    emit("info", tag, msg, fields);
  },
  warn(tag: string, msg: string, fields?: Fields): void {
    emit("warn", tag, msg, fields);
  },
  error(tag: string, msg: string, fields?: Fields): void {
    emit("error", tag, msg, fields);
  },
  debug(tag: string, msg: string, fields?: Fields): void {
    if (!DEBUG) return;
    emit("debug", tag, msg, fields);
  },
  /**
   * A record for one channel that does not appear in the operational log.
   * Does nothing in a process that has no data folder to write to.
   */
  event(
    channel: Channel,
    tag: string,
    msg: string,
    fields?: Fields,
    level: Exclude<Level, "debug"> = "info",
  ): void {
    if (!sinkInstalled()) return;
    sinkWrite({ level, channel, tag, msg, fields, text: null });
  },
};

/** Truncate a string for inline logging — avoids multi-line log bombs. */
export function snippet(s: string | null | undefined, max = 120): string {
  if (!s) return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Short human duration like "4.2s" / "312ms" / "2m14s". */
export function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms - m * 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * Compact count for token / row metrics: 576704 → "577k", 1582 → "1.6k",
 * 944 → "944". Single-precision past 1k, single-decimal in the 10s of
 * thousands range, integer past 1M.
 */
export function humanCount(n: number | undefined | null): string {
  if (n == null) return "0";
  if (n < 0) return `-${humanCount(-n)}`;
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** Money. $0.32 → "$0.32"; tiny amounts get more precision. */
export function humanCost(usd: number | undefined | null): string {
  if (usd == null) return "$0.00";
  const abs = Math.abs(usd);
  if (abs < 0.01) return `$${usd.toFixed(4)}`;
  if (abs < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Shorten a session key for log output. Strips the `imessage:` prefix
 * and shortens long group hashes:
 *   imessage:dm:+15550100001      → dm:+15550100001
 *   imessage:group:any;+;a86xy... → group:a86xy…
 */
export function shortSession(key: string): string {
  return key.replace(/^imessage:/, "").replace(/^(group:)[\w;+]*([a-f0-9]{6})[a-f0-9]*/i, "$1$2…");
}

/**
 * Render an ASCII progress bar in [▓░] characters. Length is fixed at
 * 10 cells. `pct` is 0..100. Used by the recall coverage log line to
 * give a visual sense of how far backfill has progressed.
 */
export function progressBar(pct: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return `${"▓".repeat(filled)}${"░".repeat(width - filled)}`;
}
