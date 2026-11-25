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
 *
 * Each record also says what the request itself gives away: which public
 * name it was sent to, the country Cloudflare saw it come from, what kind of
 * client the user agent claims to be, and which known probes it matches
 * (inbound-signals.ts). And each client is watched over ten minutes: one
 * that matches probe after probe, asks for page after page that is not
 * there, is refused again and again, or sends hundreds of requests a minute
 * gets one line in the `security` channel saying so (`scan`, `brute-force`,
 * `flood`), not one per request.
 *
 * And an address the security watch has blocked is answered 403 here,
 * before the server's handler runs, and recorded with `blocked`.
 */
import { blockedReason } from "./blocklist.ts";
import { classifyClient, threatSignals } from "./inbound-signals.ts";
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

// --- watching each client ---------------------------------------------------
//
// Measured on the public router's first hours of records (2026-11-25): a
// person opening a page makes a few dozen requests in a burst and almost none
// that fail. The thresholds sit far above that and far below what a scanner
// does, which is hundreds of addresses that are not there.

const WATCH_WINDOW_MS = 10 * 60_000;
/** Requests in one minute from one client. */
const FLOOD_PER_MINUTE = 300;
/** Requests matching a known probe, in the window. */
const SCAN_PROBES = 5;
/** Different addresses that were not there, in the window. */
const SCAN_NOT_FOUND = 20;
/** Refusals (401, 403), in the window. */
const BRUTE_FORCE_DENIED = 8;

type Watched = {
  windowStart: number;
  requests: number;
  probes: number;
  denied: number;
  notFound: Set<string>;
  minuteStart: number;
  minuteRequests: number;
  said: Set<string>;
};
const watched = new Map<string, Watched>();
const seenToday = new Set<string>();
let seenDay = "";

type Observed = {
  server: string;
  client: string;
  path: string;
  status: number;
  probes: string[];
  isPublic: boolean;
  fields: Record<string, unknown>;
};

function watchClient(o: Observed, now: number): void {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== seenDay) {
    seenDay = day;
    seenToday.clear();
  }
  const key = `${o.server}|${o.client}`;
  // Who is new today, among those who came from outside.
  if (o.isPublic && !seenToday.has(key) && seenToday.size < 20_000) {
    seenToday.add(key);
    log.event("security", "inbound", `first request today from ${o.client} to ${o.server}`, {
      ...o.fields,
      kind: "new-client",
    });
  }
  let w = watched.get(key);
  if (!w || now - w.windowStart >= WATCH_WINDOW_MS) {
    if (!w && watched.size > 5_000) {
      for (const [k, v] of watched) if (now - v.windowStart >= WATCH_WINDOW_MS) watched.delete(k);
    }
    w = {
      windowStart: now,
      requests: 0,
      probes: 0,
      denied: 0,
      notFound: new Set(),
      minuteStart: now,
      minuteRequests: 0,
      said: new Set(),
    };
    watched.set(key, w);
  }
  if (now - w.minuteStart >= 60_000) {
    w.minuteStart = now;
    w.minuteRequests = 0;
  }
  w.requests++;
  w.minuteRequests++;
  if (o.probes.length > 0) w.probes++;
  if (o.status === 401 || o.status === 403) w.denied++;
  if (o.status === 404 && w.notFound.size < 200) w.notFound.add(o.path);

  const say = (kind: string, what: string) => {
    if (w.said.has(kind)) return;
    w.said.add(kind);
    log.event(
      "security",
      "inbound",
      `${kind} from ${o.client} on ${o.server}: ${what}`,
      {
        kind,
        server: o.server,
        client: o.client,
        country: o.fields.country,
        client_kind: o.fields.client,
        ua: o.fields.ua,
        requests: w.requests,
        probes: w.probes,
        denied: w.denied,
        not_found: w.notFound.size,
        window_s: Math.round((now - w.windowStart) / 1000),
      },
      "warn",
    );
  };
  if (w.minuteRequests >= FLOOD_PER_MINUTE)
    say("flood", `${w.minuteRequests} requests in a minute`);
  if (w.probes >= SCAN_PROBES) say("scan", `${w.probes} requests matching known probes`);
  else if (w.notFound.size >= SCAN_NOT_FOUND) {
    say("scan", `${w.notFound.size} different addresses that are not here`);
  }
  if (w.denied >= BRUTE_FORCE_DENIED) say("brute-force", `${w.denied} requests refused`);
}

/**
 * Wrap a `Bun.serve` fetch handler so each request leaves a record. The
 * handler's answer, including "no response, the socket was upgraded", passes
 * through unchanged.
 */
export function withAccessLog<S, R extends Response | undefined>(
  server: string,
  handler: (req: Request, srv: S) => MaybePromise<R>,
  options: {
    /**
     * True for a request another harness server handed over, having recorded
     * it at the door: it is filed here as `relayed`, and is not a second
     * visitor to count, watch or flag.
     */
    relayed?: (req: Request) => boolean;
  } = {},
): (req: Request, srv: S) => Promise<R> {
  return async function accessLogged(this: unknown, req: Request, srv: S): Promise<R> {
    const started = performance.now();
    let status = 500;
    let failure: string | undefined;
    let blocked = false;
    try {
      // An address the security watch blocked is refused here, before the
      // server's own code reads anything it sent (util/blocklist.ts). A
      // request another harness server handed over was checked at the door.
      if (!(options.relayed?.(req) ?? false)) {
        const who = callerOf(req, srv);
        if (blockedReason(who.via ?? who.ip) !== null) {
          blocked = true;
          status = 403;
          return new Response("Forbidden", { status: 403 }) as R;
        }
      }
      const response = await handler.call(this, req, srv);
      // No response from a fetch handler means the connection became a WebSocket.
      status = response instanceof Response ? response.status : 101;
      return response;
    } catch (err) {
      failure = (err as Error)?.message ?? String(err);
      throw err;
    } finally {
      let path = "";
      let address = "";
      try {
        const url = new URL(req.url);
        path = safePath(url.pathname);
        address = url.pathname + url.search;
      } catch {}
      const relayed = options.relayed?.(req) ?? false;
      const seen = callerOf(req, srv);
      const caller: { ip?: string; via?: string } = relayed ? { ip: seen.ip } : seen;
      const userAgent = req.headers.get("user-agent");
      const client = classifyClient(userAgent);
      // The query is read here and nowhere kept: only the names of what it matched.
      const probes = threatSignals(req.method, address, userAgent);
      const host = req.headers.get("host") ?? undefined;
      const fields = {
        server,
        method: req.method,
        path,
        status,
        ms: Math.round(performance.now() - started),
        ...caller,
        ...(host ? { host } : {}),
        ...(req.headers.get("cf-ipcountry") ? { country: req.headers.get("cf-ipcountry") } : {}),
        client: client.name ? `${client.kind}:${client.name}` : client.kind,
        ua: (userAgent ?? "").slice(0, 120) || undefined,
        ...(probes.length > 0 ? { probes } : {}),
        ...(relayed ? { relayed: true } : {}),
        ...(blocked ? { blocked: true } : {}),
        ...(failure ? { err: failure } : {}),
      };
      const line = `${server} ${req.method} ${path} ${status}`;
      const now = Date.now();
      const routine = req.method === "GET" && status < 400 && probes.length === 0;
      if (!routine || !countedAsRepeat(line, fields, fields.ms, now)) {
        // A request that asked for something that is not here is the asker's
        // mistake, not a fault: only a failure of the server is a warning.
        log.event("net-in", "net-in", line, fields, status >= 500 ? "warn" : "info");
      }
      // For a relayed request, the server that took it from outside has
      // already filed what follows. (Not a `return`: this is a `finally`, and
      // returning here would replace the handler's answer.)
      // A blocked address was refused by rule, not by the server: its
      // refusals are not a login being guessed at, and are not counted as one.
      if (!relayed && !blocked) {
        if (status === 401 || status === 403 || status === 429) {
          log.event("security", "net-in", `${line} denied`, fields);
        }
        if (probes.length > 0) {
          log.event("security", "inbound", `probe ${probes.join(",")}: ${line}`, {
            ...fields,
            kind: "probe",
          });
        }
        watchClient(
          {
            server,
            client: caller.via ?? caller.ip ?? "?",
            path,
            status,
            probes,
            isPublic: caller.via !== undefined,
            fields,
          },
          now,
        );
      }
    }
  };
}
