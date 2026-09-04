/**
 * OpenRouter key management — the Provisioning API plus the two read
 * endpoints any ordinary key can call about itself and its account.
 *
 * Verified against the live docs 2026-09-02:
 *   POST   /api/v1/keys           { name, limit, limit_reset?, expires_at? }
 *                                 → { key: "sk-or-v1-…", data: {...} }
 *                                 The plaintext `key` is returned exactly
 *                                 once; it cannot be fetched again.
 *   GET    /api/v1/keys/{hash}    → { data: { usage, limit, limit_remaining, … } }
 *   PATCH  /api/v1/keys/{hash}    { limit?, disabled?, name? }
 *   GET    /api/v1/key            (any key, about itself) → same shape
 *   GET    /api/v1/credits        (any key) → { total_credits, total_usage }
 *
 * The first three need a PROVISIONING key (openrouter.ai/settings/
 * provisioning-keys); a provisioning key cannot run models, and a model key
 * cannot mint keys, so the two never substitute for each other.
 *
 * `fetch` is injectable everywhere so tests pin the exact request shape
 * without a network.
 */

const BASE = "https://openrouter.ai/api/v1";

export type FetchLike = typeof fetch;

export type KeyStatus = {
  hash: string | null;
  name: string | null;
  /** USD ceiling, or null for unlimited. */
  limitUsd: number | null;
  /** USD left under the ceiling, or null when unlimited. */
  remainingUsd: number | null;
  /** Lifetime USD spent on this key. */
  usageUsd: number;
  disabled: boolean;
};

export class OpenRouterKeysError extends Error {
  status: number;
  constructor(op: string, status: number, body: string) {
    super(`${op} ${status}: ${body.slice(0, 300)}`);
    this.name = "OpenRouterKeysError";
    this.status = status;
  }
}

type RawKeyData = {
  hash?: string;
  name?: string;
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  disabled?: boolean;
};

function headers(bearer: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/edmund-harness",
    "X-Title": "edmund-harness",
  };
}

function toStatus(d: RawKeyData | undefined): KeyStatus {
  return {
    hash: d?.hash ?? null,
    name: d?.name ?? d?.label ?? null,
    limitUsd: typeof d?.limit === "number" ? d.limit : null,
    remainingUsd: typeof d?.limit_remaining === "number" ? d.limit_remaining : null,
    usageUsd: typeof d?.usage === "number" ? d.usage : 0,
    disabled: d?.disabled === true,
  };
}

async function call<T>(
  op: string,
  f: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new OpenRouterKeysError(op, res.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OpenRouterKeysError(op, res.status, `unparseable body: ${text}`);
  }
}

export async function createKey(p: {
  provisioningKey: string;
  name: string;
  limitUsd: number;
  fetch?: FetchLike;
}): Promise<{ apiKey: string; status: KeyStatus }> {
  const body = await call<{ key?: string; data?: RawKeyData }>(
    "createKey",
    p.fetch ?? fetch,
    `${BASE}/keys`,
    {
      method: "POST",
      headers: headers(p.provisioningKey),
      body: JSON.stringify({ name: p.name, limit: p.limitUsd }),
    },
  );
  if (!body.key) throw new OpenRouterKeysError("createKey", 200, "response carried no key");
  return { apiKey: body.key, status: toStatus(body.data) };
}

export async function getKey(p: {
  provisioningKey: string;
  hash: string;
  fetch?: FetchLike;
}): Promise<KeyStatus> {
  const body = await call<{ data?: RawKeyData }>(
    "getKey",
    p.fetch ?? fetch,
    `${BASE}/keys/${encodeURIComponent(p.hash)}`,
    { method: "GET", headers: headers(p.provisioningKey) },
  );
  return toStatus(body.data);
}

export async function updateKey(p: {
  provisioningKey: string;
  hash: string;
  patch: { limitUsd?: number; disabled?: boolean; name?: string };
  fetch?: FetchLike;
}): Promise<KeyStatus> {
  const patch: Record<string, unknown> = {};
  if (p.patch.limitUsd !== undefined) patch.limit = p.patch.limitUsd;
  if (p.patch.disabled !== undefined) patch.disabled = p.patch.disabled;
  if (p.patch.name !== undefined) patch.name = p.patch.name;
  const body = await call<{ data?: RawKeyData }>(
    "updateKey",
    p.fetch ?? fetch,
    `${BASE}/keys/${encodeURIComponent(p.hash)}`,
    { method: "PATCH", headers: headers(p.provisioningKey), body: JSON.stringify(patch) },
  );
  return toStatus(body.data);
}

/** What a key knows about itself — usage and remaining limit — with no
 *  provisioning key involved. This is how the bg-runner and MCP process
 *  read a person's balance: with that person's own key. */
export async function keySelfStatus(p: { apiKey: string; fetch?: FetchLike }): Promise<KeyStatus> {
  const body = await call<{ data?: RawKeyData }>(
    "keySelfStatus",
    p.fetch ?? fetch,
    `${BASE}/key`,
    { method: "GET", headers: headers(p.apiKey) },
    10_000,
  );
  return toStatus(body.data);
}

/** Account-wide credit — what actually pays for every wallet. */
export async function accountCredits(p: {
  apiKey: string;
  fetch?: FetchLike;
}): Promise<{ totalCreditsUsd: number; totalUsageUsd: number; remainingUsd: number }> {
  const body = await call<{ data?: { total_credits?: number; total_usage?: number } }>(
    "accountCredits",
    p.fetch ?? fetch,
    `${BASE}/credits`,
    { method: "GET", headers: headers(p.apiKey) },
    10_000,
  );
  const total = body.data?.total_credits ?? 0;
  const used = body.data?.total_usage ?? 0;
  return { totalCreditsUsd: total, totalUsageUsd: used, remainingUsd: total - used };
}
