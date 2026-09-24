/**
 * A small client for Jev, TypeSafe's decision model on OpenRouter. It is not
 * called through chat completions: a request is `{model, state, questions}`
 * and each answer comes back under its question's id. `noul` answers are the
 * probability of yes; `score` answers are the expected level.
 *
 * Overload (HTTP 529) and network failures are common in bursts, so each call
 * retries with backoff, and at most MAX_IN_FLIGHT requests run at once. A
 * caller that cannot get an answer gets a throw: deciding without one is the
 * caller's policy, never this module's.
 */

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const RETRY_DELAYS_MS = [500, 1500, 4000];
const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT = 3;

export type JevQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true: unknown; false: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export type JevResult = {
  /** Question id → probability of yes (noul), expected level (score) or chosen option (choice). */
  answers: Record<string, number | string>;
  cost: number;
  /** Each request and how it went, e.g. "HTTP 529 after 1.2s". */
  attempts: string[];
};

export type JevOptions = {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

let inFlight = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<() => void> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  return () => {
    inFlight--;
    waiting.shift()?.();
  };
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  o: JevOptions,
): Promise<JevResult> {
  if (!o.apiKey) throw new Error("no OpenRouter key ([keys].openrouter)");
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const release = await slot();
  const attempts: string[] = [];
  try {
    let last = "no attempt made";
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      const sent = Date.now();
      const took = () => `${((Date.now() - sent) / 1000).toFixed(1)}s`;
      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: o.model, state, questions }),
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        attempts.push(`no answer after ${took()}: ${why}`);
        last = `could not reach Jev: ${why}`;
        continue;
      }
      attempts.push(`HTTP ${res.status} after ${took()}`);
      if (res.status === 429 || res.status >= 500) {
        last = `Jev answered HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) throw new Error(`Jev refused the request: HTTP ${res.status}`);
      return { ...readAnswers(await res.json(), Object.keys(questions)), attempts };
    }
    throw new Error(last);
  } finally {
    release();
  }
}

/** Every asked question's answer from a decisions response; throws if any is missing. */
export function readAnswers(body: unknown, ids: string[]): Omit<JevResult, "attempts"> {
  const b = body as {
    answers?: Record<string, Record<string, unknown>>;
    usage?: { cost?: number };
  };
  const answers: Record<string, number | string> = {};
  for (const id of ids) {
    const a = b.answers?.[id];
    const value = a?.type === "noul" ? a.noul : a?.type === "score" ? a.score : a?.choice;
    if (typeof value !== "number" && typeof value !== "string") {
      throw new Error(`Jev response is missing an answer for "${id}"`);
    }
    answers[id] = value;
  }
  return { answers, cost: typeof b.usage?.cost === "number" ? b.usage.cost : 0 };
}
