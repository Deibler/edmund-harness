import type { ChatDb } from "../imessage/db.ts";
import { guardedFetch } from "../web/fetch.ts";
import type { TriggerSource } from "./store.ts";

/**
 * Trigger evaluation: run the model-authored probe (URL fetch or a JS
 * expression inside the live RadarOmega renderer), then the model-authored
 * predicate over the result. Zero model tokens — that's the point.
 */

export type EvalResult = {
  fire: boolean;
  /** What happened — becomes the wake-up context when firing. */
  summary: string;
  /** Updated predicate scratch state to persist. */
  state: Record<string, unknown>;
};

export type ProbeRunner = (source: TriggerSource) => Promise<unknown>;

/** Hard kill for a single predicate run. Predicates are pure data checks —
 *  the probe already did the network — so anything near this is a bug. */
const PREDICATE_TIMEOUT_MS = 10_000;

const EVALUATOR_URL = new URL("./predicate-eval.ts", import.meta.url);

type PredicateOutcome = {
  fire: boolean;
  summary: string;
  scratch: Record<string, unknown>;
};

/**
 * Run a model-authored predicate in a short-lived worker thread. The model
 * already holds unrestricted Bash on this machine, so this is not a security
 * boundary — it's a LIVENESS one: an infinite loop or catastrophic regex in
 * a predicate gets its own worker terminated instead of freezing the daemon's
 * event loop (which every session, cron, and watcher shares).
 */
async function runPredicate(
  predicate: string,
  data: unknown,
  scratch: Record<string, unknown>,
  timeoutMs: number,
): Promise<PredicateOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(EVALUATOR_URL, { name: "trigger-predicate" });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `predicate timed out after ${Math.round(timeoutMs / 1000)}s and was terminated — rewrite it to return quickly (no loops over unbounded data)`,
          ),
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    worker.onmessage = (event: MessageEvent<PredicateWorkerResponse>) => {
      const response = event.data;
      if (!response.ok) {
        finish(() => reject(new Error(response.error || "predicate failed")));
        return;
      }
      finish(() =>
        resolve({
          fire: response.fire === true,
          summary: typeof response.summary === "string" ? response.summary : "no summary",
          scratch: response.scratch && typeof response.scratch === "object" ? response.scratch : {},
        }),
      );
    };
    worker.onerror = (event: ErrorEvent) => {
      finish(() => reject(new Error(event.message || "predicate worker crashed")));
    };
    worker.postMessage({ predicate, data, state: scratch });
  });
}

type PredicateWorkerResponse =
  | { ok: true; fire: boolean; summary: string; scratch: Record<string, unknown> }
  | { ok: false; error: string };

export async function evaluateTrigger(
  source: TriggerSource,
  predicate: string,
  state: Record<string, unknown>,
  probe: ProbeRunner,
  opts?: { timeoutMs?: number },
): Promise<EvalResult> {
  const data = await probe(source);

  const scratch: Record<string, unknown> =
    state.scratch && typeof state.scratch === "object"
      ? (state.scratch as Record<string, unknown>)
      : {};

  const r = await runPredicate(predicate, data, scratch, opts?.timeoutMs ?? PREDICATE_TIMEOUT_MS);
  return { fire: r.fire, summary: r.summary, state: { ...state, scratch: r.scratch } };
}

// ─── Probes ───────────────────────────────────────────────────────────

/** A response that may clear on its own: a timeout or dropped connection, a
 *  server-side failure, or a rate limit. 4xx says the request itself is wrong
 *  and will be exactly as wrong a moment later. */
function isTransientProbeError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number") return status >= 500 || status === 429;
  return true; // thrown by fetch itself: timeout, DNS, refused, reset
}

/** Pause between the two probe attempts, long enough for a load blip to pass. */
const PROBE_RETRY_WAIT_MS = 3_000;

/** URL probe: 12s timeout, identifies the harness (NWS policy).
 *  `method: "POST"` + `body` turn it into a webhook-style call for
 *  endpoints that only answer to POST (GraphQL, RPC-ish APIs).
 *
 *  One retry on a transient failure, because a single slow response is not a
 *  broken trigger: weather feeds get slow exactly when they matter (IEM's LSR
 *  endpoint under storm load), and without the retry each blip counted as a
 *  check failure and walked good triggers toward backoff and the
 *  persistent-failure alert. A feed that is genuinely down still fails both
 *  attempts and escalates the same way. */
export async function probeUrl(
  url: string,
  headers?: Record<string, string>,
  opts?: { method?: "GET" | "POST"; body?: string; fetchImpl?: typeof guardedFetch },
): Promise<unknown> {
  const method = opts?.method ?? "GET";
  // Model-authored URL, so the same SSRF guard as web_fetch, on every hop.
  // Tests inject a plain fetch to exercise the retry logic against a local
  // server; production never passes one.
  const doFetch = opts?.fetchImpl ?? guardedFetch;
  const attempt = async (): Promise<unknown> => {
    const res = await doFetch(url, {
      method,
      headers: {
        "User-Agent": "edmund-harness",
        Accept: "application/geo+json, application/json;q=0.9, */*;q=0.5",
        ...(method === "POST" && opts?.body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(method === "POST" && opts?.body !== undefined ? { body: opts.body } : {}),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${url}`);
      (err as Error & { status: number }).status = res.status;
      throw err;
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON endpoints (text products etc.) hand the raw body to the predicate.
      return text;
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (!isTransientProbeError(err)) throw err;
    await new Promise((r) => setTimeout(r, PROBE_RETRY_WAIT_MS));
    return attempt();
  }
}

/**
 * chat_silence probe: the harness's own internal state as trigger data.
 * "If I haven't heard from X in N days, wake me" becomes a predicate over
 * { hoursSinceInbound }. Tapbacks don't count as hearing from someone.
 */
export function probeChatSilence(
  chatDb: ChatDb,
  source: { handle?: string; chatGuid?: string },
  nowMs = Date.now(),
): unknown {
  let guid = source.chatGuid ?? null;
  if (!guid && source.handle) {
    // Same resolution the recall indexer uses: the DM chat with the most
    // messages whose guid ends ";-;<handle>" (never fabricate a guid).
    const row = chatDb
      .query<{ guid: string }>(
        `SELECT c.guid AS guid FROM chat c WHERE c.guid LIKE '%;-;' || ?
         ORDER BY (SELECT COUNT(*) FROM chat_message_join j WHERE j.chat_id = c.ROWID) DESC
         LIMIT 1`,
      )
      .get(source.handle) as { guid: string } | null | undefined;
    guid = row?.guid ?? null;
  }
  if (!guid) {
    throw new Error(
      `chat_silence: no chat found${source.handle ? ` for handle ${source.handle}` : ""} — give chatGuid or a known DM handle`,
    );
  }
  const last = (fromMe: 0 | 1): number | null => {
    const row = chatDb
      .query<{ ts_ms: number | null }>(
        `SELECT MAX((m.date / 1000000) + 978307200000) AS ts_ms
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c                ON c.ROWID = cmj.chat_id
         WHERE c.guid = ? AND m.is_from_me = ?
           AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)`,
      )
      .get(guid, fromMe) as { ts_ms: number | null } | null | undefined;
    return row?.ts_ms ?? null;
  };
  const lastInboundMs = last(0);
  const lastOutboundMs = last(1);
  const hours = (ms: number | null) =>
    ms === null ? null : Math.round(((nowMs - ms) / 3_600_000) * 10) / 10;
  return {
    chatGuid: guid,
    lastInboundMs,
    lastOutboundMs,
    hoursSinceInbound: hours(lastInboundMs),
    hoursSinceOutbound: hours(lastOutboundMs),
    nowMs,
  };
}

/**
 * app_js probe: evaluate a JS expression in the RadarOmega renderer over
 * CDP. Self-contained client on Bun's native WebSocket so the daemon
 * doesn't depend on the vendored MCP package. The app exposes its whole
 * surface to expressions: window["0"] (app modules/selectors),
 * window.__claude_map (map + radar + model engines).
 *
 * No autolaunch here — the MCP server owns app lifecycle. If the app is
 * down, the probe throws and the watcher records the error on the trigger.
 */
export async function probeAppJs(expression: string, cdpPort = 9222): Promise<unknown> {
  const targetsRes = await fetch(`http://127.0.0.1:${cdpPort}/json`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!targetsRes.ok) throw new Error(`CDP not reachable on port ${cdpPort}`);
  const targets = (await targetsRes.json()) as Array<{
    type: string;
    url: string;
    title: string;
    webSocketDebuggerUrl: string;
  }>;
  const page =
    targets.find(
      (t) =>
        t.type === "page" &&
        (t.url.includes("radaromega.com") || t.title.toLowerCase().includes("radar")),
    ) ?? targets.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("no RadarOmega page target on CDP");

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("CDP evaluate timed out (20s)"));
    }, 20_000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      fn();
    };
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
        }),
      );
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: {
            result?: { value?: unknown; description?: string; subtype?: string };
            exceptionDetails?: { exception?: { description?: string } };
          };
          error?: { message?: string };
        };
        if (msg.id !== 1) return;
        if (msg.error) return done(() => reject(new Error(`CDP: ${msg.error?.message}`)));
        const r = msg.result;
        if (r?.exceptionDetails) {
          return done(() =>
            reject(new Error(`app_js threw: ${r.exceptionDetails?.exception?.description}`)),
          );
        }
        if (r?.result?.subtype === "error") {
          return done(() => reject(new Error(`app_js error: ${r.result?.description}`)));
        }
        done(() => resolve(r?.result?.value));
      } catch (e) {
        done(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    };
    ws.onerror = () => done(() => reject(new Error("CDP websocket error")));
  });
}

/** Default probe dispatcher used by the daemon watcher. */
export function defaultProbe(cdpPort: number, chatDb?: ChatDb): ProbeRunner {
  return async (source: TriggerSource) => {
    if (source.kind === "url") {
      return probeUrl(source.url, source.headers, { method: source.method, body: source.body });
    }
    if (source.kind === "app_js") return probeAppJs(source.expression, cdpPort);
    if (source.kind === "chat_silence") {
      if (!chatDb) throw new Error("chat_silence probe needs chat.db, which is unavailable here");
      return probeChatSilence(chatDb, source);
    }
    throw new Error(`unknown trigger source kind: ${(source as { kind?: string }).kind}`);
  };
}
