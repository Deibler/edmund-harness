import type { Config } from "../../../src/config/config.ts";
import type { FetchLike } from "../../../src/credits/openrouter-keys.ts";
import { resolveBillingSession, walletSessionKeyFor } from "../../../src/credits/resolve.ts";
import type { CreditStore } from "../../../src/credits/store.ts";
import { syncWallet } from "../../../src/credits/sync.ts";
import {
  chatIdFromKey,
  isDmSession,
  isGroupSession,
  normalizeHandle,
} from "../../../src/sessions/key.ts";
import type { CreditEventDto, WalletDto } from "../types.ts";

/**
 * The rows on the operator's Credits page — every identified conversation,
 * not just the ones that already have a wallet.
 *
 * `buildCreditRows` is the cheap, local part: sessions from state.db, the
 * wallet mapping, the paywall rollup, and "pays with" through the same
 * resolver the generation path uses. `enrichLive` then asks OpenRouter and
 * Stripe about every wallet that has a key — the numbers on the page are
 * whatever those two say right now, never a local ledger.
 */

export type SessionLike = { sessionKey: string; lastInboundMs: number };

export function buildCreditRows(p: {
  config: Config;
  store: CreditStore;
  sessions: SessionLike[];
  label: (sessionKey: string) => string;
}): WalletDto[] {
  const wallets = new Map(p.store.list().map((w) => [w.sessionKey, w]));
  const summaries = p.store.eventSummaries();
  const modeOf = (k: string) => wallets.get(k)?.billingMode ?? null;

  type Seed = { key: string; kind: WalletDto["kind"]; lastInboundMs: number | null };
  const seeds = new Map<string, Seed>();
  for (const s of p.sessions) {
    const k = s.sessionKey;
    let seed: Seed | null = null;
    if (isDmSession(k) || k.startsWith("sms:dm:")) {
      seed = {
        key: walletSessionKeyFor(chatIdFromKey(k)),
        kind: "dm",
        lastInboundMs: s.lastInboundMs,
      };
    } else if (isGroupSession(k)) {
      seed = { key: k, kind: "group", lastInboundMs: s.lastInboundMs };
    }
    if (!seed) continue; // mirror, orchestrators, agents, trading: not people
    const prev = seeds.get(seed.key);
    if (!prev || (seed.lastInboundMs ?? 0) > (prev.lastInboundMs ?? 0)) seeds.set(seed.key, seed);
  }
  for (const w of wallets.values()) {
    if (!seeds.has(w.sessionKey))
      seeds.set(w.sessionKey, { key: w.sessionKey, kind: "dm", lastInboundMs: null });
  }

  const operator = p.config.alerts.operator_handle.trim();
  const operatorKey = operator ? walletSessionKeyFor(normalizeHandle(operator)) : null;

  const rows: WalletDto[] = [];
  for (const seed of seeds.values()) {
    const w = wallets.get(seed.key) ?? null;
    const target = resolveBillingSession(seed.key, {
      operatorHandle: p.config.alerts.operator_handle,
      modeOf,
      parentOf: () => null,
    });
    const paysWith: WalletDto["paysWith"] =
      target.kind === "wallet"
        ? "wallet"
        : target.reason === "operator"
          ? "house-operator"
          : target.reason === "override"
            ? "house-override"
            : "house-group";
    const ev = summaries.get(seed.key);
    const isWallet = paysWith === "wallet" && Boolean(w?.apiKey);
    rows.push({
      sessionKey: seed.key,
      handle: chatIdFromKey(seed.key),
      label: p.label(seed.key),
      kind: seed.kind,
      isOperator: seed.key === operatorKey,
      paysWith,
      billingMode: w?.billingMode ?? "wallet",
      hasKey: Boolean(w?.apiKey),
      keyHash: w?.keyHash ?? null,
      disabled: w?.disabled ?? false,
      createdAtMs: w?.createdAtMs ?? null,
      lastInboundMs: seed.lastInboundMs,
      // Fallback snapshot until enrichLive replaces it with a live read.
      live: false,
      remainingUsd: isWallet ? (w?.lastSeenRemainingUsd ?? null) : null,
      usageUsd: isWallet ? (w?.lastSeenUsageUsd ?? null) : null,
      limitUsd: isWallet ? (w?.lastSeenLimitUsd ?? null) : null,
      paidTotalUsd: null,
      creditedTotalUsd: null,
      operatorAdjustUsd: null,
      payments: [],
      paywallHits: ev?.paywallHits ?? 0,
      lastPaywallAtMs: ev?.lastPaywallAtMs ?? null,
      lastPaywallGeneration: ev?.lastPaywallGeneration ?? null,
      lastSeenAtMs: w?.lastSeenAtMs ?? null,
    });
  }

  // People first (most recent conversation on top), then groups.
  rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dm" ? -1 : 1;
    return (b.lastInboundMs ?? 0) - (a.lastInboundMs ?? 0);
  });
  return rows;
}

/**
 * Read every wallet with a key from OpenRouter and Stripe, in parallel with
 * a small pool. A row whose read fails keeps its fallback snapshot and
 * `live: false`, so one slow provider does not blank the page.
 */
export async function enrichLive(p: {
  config: Config;
  store: CreditStore;
  rows: WalletDto[];
  concurrency?: number;
  fetch?: FetchLike;
}): Promise<WalletDto[]> {
  const targets = p.rows.filter((r) => r.paysWith === "wallet" && r.hasKey);
  const queue = [...targets];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const v = await syncWallet({
          config: p.config,
          store: p.store,
          sessionKey: row.sessionKey,
          withReceipts: true,
          fetch: p.fetch,
        });
        row.live = true;
        row.remainingUsd = v.status.remainingUsd;
        row.usageUsd = v.status.usageUsd;
        row.limitUsd = v.status.limitUsd;
        row.disabled = row.disabled || v.status.disabled;
        row.paidTotalUsd = v.stripe ? v.stripe.totalPaidCents / 100 : null;
        row.creditedTotalUsd = v.stripe ? v.stripe.totalCreditedUsd : null;
        row.operatorAdjustUsd = v.operatorAdjustUsd;
        row.payments = (v.stripe?.payments ?? []).map((x) => ({
          paymentIntent: x.paymentIntent,
          checkoutSession: x.checkoutSession,
          createdMs: x.createdMs,
          paidUsd: x.paidCents / 100,
          creditedUsd: x.creditedUsd,
          receiptUrl: x.receiptUrl,
          invoicePdfUrl: x.invoicePdfUrl,
        }));
      } catch (err) {
        console.warn(
          `[credits] live read failed for ${row.sessionKey}: ${String(err).slice(0, 160)}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(p.concurrency ?? 4, targets.length || 1) }, worker),
  );
  return p.rows;
}

export function recentPaywallEvents(p: {
  store: CreditStore;
  label: (sessionKey: string) => string;
  limit?: number;
}): CreditEventDto[] {
  return p.store.recentEvents(p.limit ?? 50, true).map((e) => ({
    id: e.id,
    sessionKey: e.sessionKey,
    handle: chatIdFromKey(e.sessionKey),
    label: p.label(e.sessionKey),
    kind: e.kind,
    generation: e.generation,
    atMs: e.atMs,
    remainingUsd: e.remainingUsd,
    costUsd: e.costUsd,
    detail: e.detail,
  }));
}
