import type { FetchLike } from "./openrouter-keys.ts";
import { OpenRouterKeysError } from "./openrouter-keys.ts";

/**
 * OpenRouter's own record of what a key did — the generations, what each
 * cost, and when. This is the source for a person's activity page; nothing
 * about a generation is written locally.
 *
 * Verified live 2026-09-02 against the account's management key:
 *
 *   GET  /api/v1/analytics/meta
 *        metrics (request_count, total_usage, tokens_total, avg_latency, …),
 *        dimensions (model, api_key_id, generation_id, …), granularities
 *        (minute, hour, day, week, month), operators (eq, neq, in, …).
 *
 *   POST /api/v1/analytics/query
 *        { metrics, dimensions?, granularity?, filters?, time_range, limit? }
 *        - dimension "generation_id" → one row per generation
 *        - filter { field: "api_key_id", operator: "eq", value: <key hash> }
 *          (the 64-hex hash; the key's NAME in a filter returns 500, while
 *          api_key_id in a RESPONSE row is the name)
 *        - "minute" granularity is capped at a 3-hour range and "hour" at
 *          31 days; longer ranges need granularity >= day and daily-MV
 *          fields, which generation_id is not — so history is read in
 *          30-day windows at hour granularity
 *        - counts and token totals come back as strings, money as numbers
 *
 *   GET  /api/v1/generation?id=<id>     (with the key that made it)
 *        exact created_at, total_cost, tokens, latency, provider.
 *        (/api/v1/generations/{id}, as the docs index spells it, is 404.)
 */

const BASE = "https://openrouter.ai/api/v1";
const DAY_MS = 86_400_000;
/** Under OpenRouter's 31-day cap for hour granularity, with room for DST. */
export const WINDOW_MS = 30 * DAY_MS;

export type KeyGeneration = {
  generationId: string;
  model: string;
  /** Start of the UTC hour OpenRouter filed it under. */
  hourMs: number;
  costUsd: number;
  requests: number;
  tokens: number | null;
  latencyMs: number | null;
};

type QueryRow = {
  created_at__hour?: string;
  generation_id?: string;
  model?: string;
  request_count?: string | number;
  total_usage?: number | string;
  tokens_total?: string | number;
  avg_latency?: number | string | null;
};
type QueryResponse = {
  data?: { data?: QueryRow[]; metadata?: { truncated?: boolean } };
};

function headers(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/edmund-harness",
    "X-Title": "edmund-harness",
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "2026-09-02 16:00:00" (UTC, no zone marker) → ms. */
export function parseOpenRouterTime(s: string | undefined): number | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(/[zZ]$|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** ISO with seconds and no millis — the only form the query accepts. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** [since, until] as ≤30-day windows, newest first. */
export function windowsFor(
  sinceMs: number,
  untilMs: number,
  maxWindows: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let end = untilMs;
  while (end > sinceMs && out.length < maxWindows) {
    const start = Math.max(sinceMs, end - WINDOW_MS);
    out.push([start, end]);
    end = start;
  }
  return out;
}

async function queryWindow(p: {
  managementKey: string;
  keyHash: string;
  startMs: number;
  endMs: number;
  fetch: FetchLike;
}): Promise<KeyGeneration[]> {
  const res = await p.fetch(`${BASE}/analytics/query`, {
    method: "POST",
    headers: headers(p.managementKey),
    body: JSON.stringify({
      metrics: ["request_count", "total_usage", "tokens_total", "avg_latency"],
      dimensions: ["generation_id", "model"],
      granularity: "hour",
      filters: [{ field: "api_key_id", operator: "eq", value: p.keyHash }],
      time_range: { start: isoSeconds(p.startMs), end: isoSeconds(p.endMs) },
      limit: 1000,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new OpenRouterKeysError("analyticsQuery", res.status, text);
  const body = JSON.parse(text) as QueryResponse;
  const rows: KeyGeneration[] = [];
  for (const r of body.data?.data ?? []) {
    const hourMs = parseOpenRouterTime(r.created_at__hour);
    if (!r.generation_id || hourMs === null) continue;
    rows.push({
      generationId: r.generation_id,
      model: r.model ?? "",
      hourMs,
      costUsd: num(r.total_usage) ?? 0,
      requests: num(r.request_count) ?? 1,
      tokens: num(r.tokens_total),
      latencyMs: num(r.avg_latency),
    });
  }
  return rows;
}

/**
 * Every generation this key made between `sinceMs` and `untilMs`, straight
 * from OpenRouter. Windows are read in parallel; one that fails is reported
 * in `failedWindows` rather than failing the whole read, so a person still
 * sees most of their history when one call times out.
 */
export async function keyGenerations(p: {
  managementKey: string;
  keyHash: string;
  sinceMs: number;
  untilMs?: number;
  maxWindows?: number;
  fetch?: FetchLike;
}): Promise<{ generations: KeyGeneration[]; windows: number; failedWindows: number }> {
  const f = p.fetch ?? fetch;
  const windows = windowsFor(p.sinceMs, p.untilMs ?? Date.now(), p.maxWindows ?? 6);
  let failedWindows = 0;
  const parts = await Promise.all(
    windows.map(async ([startMs, endMs]) => {
      try {
        return await queryWindow({
          managementKey: p.managementKey,
          keyHash: p.keyHash,
          startMs,
          endMs,
          fetch: f,
        });
      } catch {
        failedWindows += 1;
        return [] as KeyGeneration[];
      }
    }),
  );
  const seen = new Set<string>();
  const generations: KeyGeneration[] = [];
  for (const g of parts.flat()) {
    if (seen.has(g.generationId)) continue;
    seen.add(g.generationId);
    generations.push(g);
  }
  generations.sort((a, b) => b.hourMs - a.hourMs);
  return { generations, windows: windows.length, failedWindows };
}

export type GenerationDetail = {
  id: string;
  createdAtMs: number | null;
  model: string | null;
  /** OpenRouter's charge for it. */
  costUsd: number | null;
  provider: string | null;
  latencyMs: number | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  /** Images/clips in the output, when OpenRouter counts them. */
  mediaOut: number | null;
  finishReason: string | null;
};

type RawGeneration = {
  data?: {
    id?: string;
    created_at?: string;
    model?: string;
    total_cost?: number;
    usage?: number;
    provider_name?: string;
    latency?: number;
    tokens_prompt?: number;
    tokens_completion?: number;
    native_tokens_completion?: number;
    num_media_completion?: number | null;
    finish_reason?: string | null;
  };
};

/** One generation's record, read with the key that made it. Null when
 *  OpenRouter has no record (yet) — a very fresh generation, or a job id
 *  that was never a generation id. */
export async function generationDetail(p: {
  apiKey: string;
  id: string;
  fetch?: FetchLike;
}): Promise<GenerationDetail | null> {
  const res = await (p.fetch ?? fetch)(`${BASE}/generation?id=${encodeURIComponent(p.id)}`, {
    headers: headers(p.apiKey),
    signal: AbortSignal.timeout(8_000),
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) throw new OpenRouterKeysError("generationDetail", res.status, text);
  const d = (JSON.parse(text) as RawGeneration).data;
  if (!d?.id) return null;
  return {
    id: d.id,
    createdAtMs: parseOpenRouterTime(d.created_at),
    model: d.model ?? null,
    costUsd: num(d.total_cost) ?? num(d.usage),
    provider: d.provider_name ?? null,
    latencyMs: num(d.latency),
    tokensPrompt: num(d.tokens_prompt),
    tokensCompletion: num(d.native_tokens_completion) ?? num(d.tokens_completion),
    mediaOut: num(d.num_media_completion),
    finishReason: d.finish_reason ?? null,
  };
}
