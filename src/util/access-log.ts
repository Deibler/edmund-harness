/**
 * A record of every request a harness server answers.
 *
 * Until 2026-11-25 no server here kept one: the 2026-10-04 security review
 * could say what the dashboard, the portal, the SMS and Grok webhooks and the
 * public router would do with a request, and nothing about what they had been
 * asked. Each server's handler is wrapped once, where it is given to
 * `Bun.serve`, and each request becomes one `net-in` record: which server,
 * method, path, status, how long it took and who asked. A 401, 403 or 429 is
 * copied to the `security` channel.
 *
 * Kept out: query strings, headers and bodies, which is where tokens and
 * message text travel. Long opaque path segments are cut to six characters,
 * enough to tell two share links apart and not enough to use one.
 *
 * A successful GET that the same caller repeats within a minute is counted,
 * not repeated: an open dashboard tab polls a handful of endpoints every
 * couple of seconds, which is a quarter of a million identical lines a day.
 * The first one is recorded as it happens and the rest as one line a minute
 * with their number and timing. Anything that changes something, and anything
 * refused or failed, is always its own record.
 */
import { safePath } from "./log-instrument.ts";
import { log } from "./log.ts";

type MaybePromise<T> = T | Promise<T>;

/** The part of Bun's server a handler is handed, as far as this needs it. */
type AddressSource = { requestIP?: (req: Request) => { address: string } | null };

function callerOf(req: Request, server: unknown): { ip?: string; via?: string } {
  let ip: string | undefined;
  try {
    ip = (server as AddressSource | undefined)?.requestIP?.(req)?.address;
  } catch {}
  // A request that came through a tunnel arrives from loopback; the tunnel says who sent it.
  const via =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined;
  return { ...(ip ? { ip } : {}), ...(via ? { via } : {}) };
}

const REPEAT_WINDOW_MS = 60_000;

type Repeats = {
  since: number;
  count: number;
  totalMs: number;
  maxMs: number;
  line: string;
  fields: Record<string, unknown>;
};
const repeats = new Map<string, Repeats>();
let repeatTimer: ReturnType<typeof setInterval> | null = null;

function reportRepeats(entry: Repeats): void {
  if (entry.count === 0) return;
  log.event("net-in", "net-in", `${entry.line} repeated ${entry.count} more`, {
    ...entry.fields,
    count: entry.count,
    avg_ms: Math.round(entry.totalMs / entry.count),
    max_ms: entry.maxMs,
    ms: undefined,
  });
}

function flushRepeats(now: number = Date.now()): void {
  for (const [key, entry] of repeats) {
    if (now - entry.since < REPEAT_WINDOW_MS) continue;
    reportRepeats(entry);
    repeats.delete(key);
  }
  if (repeats.size === 0 && repeatTimer) {
    clearInterval(repeatTimer);
    repeatTimer = null;
  }
}

/** True when this request is a repeat that has been counted and needs no record of its own. */
function countedAsRepeat(
  line: string,
  fields: Record<string, unknown>,
  ms: number,
  now: number,
): boolean {
  const key = `${line}|${fields.ip ?? ""}|${fields.via ?? ""}`;
  const entry = repeats.get(key);
  if (entry && now - entry.since < REPEAT_WINDOW_MS) {
    entry.count++;
    entry.totalMs += ms;
    entry.maxMs = Math.max(entry.maxMs, ms);
    return true;
  }
  if (entry) reportRepeats(entry);
  repeats.set(key, { since: now, count: 0, totalMs: 0, maxMs: 0, line, fields });
  if (!repeatTimer) {
    repeatTimer = setInterval(flushRepeats, REPEAT_WINDOW_MS);
    repeatTimer.unref?.();
  }
  return false;
}

/**
 * Wrap a `Bun.serve` fetch handler so each request leaves a record. The
 * handler's answer, including "no response, the socket was upgraded", passes
 * through unchanged.
 */
export function withAccessLog<S, R extends Response | undefined>(
  server: string,
  handler: (req: Request, srv: S) => MaybePromise<R>,
): (req: Request, srv: S) => Promise<R> {
  return async function accessLogged(this: unknown, req: Request, srv: S): Promise<R> {
    const started = performance.now();
    let status = 500;
    let failure: string | undefined;
    try {
      const response = await handler.call(this, req, srv);
      // No response from a fetch handler means the connection became a WebSocket.
      status = response instanceof Response ? response.status : 101;
      return response;
    } catch (err) {
      failure = (err as Error)?.message ?? String(err);
      throw err;
    } finally {
      let path = "";
      try {
        path = safePath(new URL(req.url).pathname);
      } catch {}
      const fields = {
        server,
        method: req.method,
        path,
        status,
        ms: Math.round(performance.now() - started),
        ...callerOf(req, srv),
        ua: (req.headers.get("user-agent") ?? "").slice(0, 120) || undefined,
        ...(failure ? { err: failure } : {}),
      };
      const line = `${server} ${req.method} ${path} ${status}`;
      const routine = req.method === "GET" && status < 400;
      if (!routine || !countedAsRepeat(line, fields, fields.ms, Date.now())) {
        log.event("net-in", "net-in", line, fields, status >= 400 ? "warn" : "info");
      }
      if (status === 401 || status === 403 || status === 429) {
        log.event("security", "net-in", `${line} denied`, fields, "warn");
      }
    }
  };
}
