/**
 * Structured logger with DEBUG gating.
 *
 * Thin wrapper over console so the log-sink (log-sink.ts) still
 * captures output into data/daemon.log. Format is
 *   [tag] message key=val key=val ...
 * which is greppable (`rg '\[tool\]'`) and easy to scan.
 *
 * DEBUG is on when EDMUND_LOG_LEVEL=debug OR DEBUG=1. When off,
 * `log.debug(...)` is a no-op. Turn it on at boot with
 *   EDMUND_LOG_LEVEL=debug bun src/main.ts
 * or persistently via the launchd plist / service.sh.
 */

export const DEBUG =
  process.env.EDMUND_LOG_LEVEL === "debug" ||
  process.env.DEBUG === "1" ||
  process.env.DEBUG === "true";

export type Fields = Record<string, unknown>;

const SECRET_KEY = /key|token|secret|password|authorization/i;
const MAX_VALUE_LEN = 240;

function fmtValue(key: string, v: unknown): string {
  if (SECRET_KEY.test(key)) return "***";
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

export const log = {
  info(tag: string, msg: string, fields?: Fields): void {
    console.log(`[${tag}] ${msg}${fmtFields(fields)}`);
  },
  warn(tag: string, msg: string, fields?: Fields): void {
    console.warn(`[${tag}] ${msg}${fmtFields(fields)}`);
  },
  error(tag: string, msg: string, fields?: Fields): void {
    console.error(`[${tag}] ${msg}${fmtFields(fields)}`);
  },
  debug(tag: string, msg: string, fields?: Fields): void {
    if (!DEBUG) return;
    console.log(`[${tag}] [debug] ${msg}${fmtFields(fields)}`);
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
