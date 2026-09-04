import { type GenerationDetail, generationDetail, keyGenerations } from "./analytics.ts";
import type { StripePayment } from "./ledger.ts";
import type { FetchLike } from "./openrouter-keys.ts";
import type { CreditEventKind, CreditStore, GenerationKind, Wallet } from "./store.ts";

/**
 * A person's statement: every generation on their key with what it cost,
 * every payment, and the balance after each line — assembled on every
 * open from the three systems that hold it.
 *
 *   OpenRouter  the generations (analytics, per generation id), each one's
 *               exact time and cost (generation record), and the balance
 *               right now
 *   Stripe      the payments and what each became in credit
 *   state.db    only the refusals — the paywall saying no is our act, and
 *               neither OpenRouter nor Stripe ever saw it
 *
 * The balance column is derived, not stored: start from what OpenRouter
 * says is left right now and walk backwards, adding each generation's cost
 * back and taking each payment off. The one thing that has no timestamp
 * anywhere is credit the operator added by hand (a limit raised on
 * OpenRouter, which keeps no history of it); it is shown as an opening
 * line dated when the key was minted, and balances before a later gift
 * would read low by that amount.
 */

export type MediaKind = "image" | "video" | "audio" | "other";

export type ActivityKind =
  | "generation"
  | "payment"
  | "starter"
  | "operator-credit"
  | CreditEventKind;

export type ActivityRow = {
  atMs: number;
  /** False when only OpenRouter's hour bucket is known for the moment. */
  atExact: boolean;
  kind: ActivityKind;
  media: MediaKind | null;
  model: string | null;
  generationId: string | null;
  provider: string | null;
  /** USD OpenRouter charged for this generation. */
  costUsd: number | null;
  /** USD this line added to the person's credit. */
  creditUsd: number | null;
  tokens: number | null;
  latencyMs: number | null;
  /** Credit left after this line, or null when the live balance is unknown. */
  balanceAfterUsd: number | null;
  detail: string | null;
  /** Stripe payment id for a payment line. */
  reference: string | null;
};

export type Activity = {
  rows: ActivityRow[];
  /** Start of the history that was asked of OpenRouter. */
  sinceMs: number;
  /** False when one or more history windows could not be read this time. */
  complete: boolean;
  generations: number;
  spentUsd: number;
};

/** Which kind of thing a model makes, from its slug (and OpenRouter's
 *  count of media in the output when the slug does not say). */
export function mediaKindOf(model: string | null, mediaOut?: number | null): MediaKind {
  const m = (model ?? "").toLowerCase();
  if (/veo|video|sora|kling|hailuo|runway|luma|wan2|wan-/.test(m)) return "video";
  if (/audio|tts|speech|whisper|voice|eleven/.test(m)) return "audio";
  if (/image|flux|imagen|dall-e|stable-diffusion|sdxl|seedream|ideogram|recraft/.test(m)) {
    return "image";
  }
  if (mediaOut && mediaOut > 0) return "image";
  return "other";
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/** Same-instant ordering, newest first: a generation before the credit that
 *  paid for it, refusals between. */
const RANK: Record<string, number> = {
  generation: 0,
  payment: 3,
  starter: 4,
  "operator-credit": 5,
};
const rank = (k: ActivityKind) => RANK[k] ?? 1;

export async function walletActivity(p: {
  managementKey: string;
  store: CreditStore;
  wallet: Wallet;
  /** Stripe's payments for this wallet; null when Stripe was unreadable. */
  payments: StripePayment[] | null;
  /** OpenRouter's limit_remaining right now; null when unknown. */
  remainingNowUsd: number | null;
  /** Credit above starter + payments — the operator's hand on the limit. */
  operatorAdjustUsd: number | null;
  nowMs?: number;
  sinceMs?: number;
  maxWindows?: number;
  /** How many of the newest generations get their exact record read. */
  detailLookups?: number;
  fetch?: FetchLike;
}): Promise<Activity> {
  const now = p.nowMs ?? Date.now();
  const f = p.fetch ?? fetch;
  const maxWindows = p.maxWindows ?? 6;
  const sinceMs = Math.max(
    p.sinceMs ?? p.wallet.createdAtMs - 3_600_000,
    now - maxWindows * 30 * 86_400_000,
  );

  const rows: ActivityRow[] = [];
  let complete = true;

  if (p.wallet.keyHash) {
    const read = await keyGenerations({
      managementKey: p.managementKey,
      keyHash: p.wallet.keyHash,
      sinceMs,
      untilMs: now,
      maxWindows,
      fetch: f,
    });
    complete = read.failedWindows === 0;
    for (const g of read.generations) {
      rows.push({
        atMs: g.hourMs,
        atExact: false,
        kind: "generation",
        media: mediaKindOf(g.model),
        model: g.model || null,
        generationId: g.generationId,
        provider: null,
        costUsd: g.costUsd,
        creditUsd: null,
        tokens: g.tokens,
        latencyMs: g.latencyMs,
        balanceAfterUsd: null,
        detail: null,
        reference: null,
      });
    }
    // Exact moment and OpenRouter's final figure for the newest ones, read
    // with the person's own key, a few at a time.
    if (p.wallet.apiKey) {
      const targets = rows.slice(0, p.detailLookups ?? 40);
      const queue = [...targets];
      const apiKey = p.wallet.apiKey;
      const worker = async () => {
        for (let r = queue.shift(); r; r = queue.shift()) {
          let d: GenerationDetail | null = null;
          try {
            d = await generationDetail({ apiKey, id: r.generationId!, fetch: f });
          } catch {
            // the hour bucket and analytics cost stand
          }
          if (!d) continue;
          if (d.createdAtMs !== null) {
            r.atMs = d.createdAtMs;
            r.atExact = true;
          }
          if (d.costUsd !== null) r.costUsd = d.costUsd;
          if (d.model && !r.model) r.model = d.model;
          r.provider = d.provider;
          if (d.latencyMs !== null) r.latencyMs = d.latencyMs;
          if (d.tokensPrompt !== null || d.tokensCompletion !== null) {
            r.tokens = (d.tokensPrompt ?? 0) + (d.tokensCompletion ?? 0);
          }
          r.media = mediaKindOf(r.model, d.mediaOut);
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, targets.length || 1) }, worker));
    }
  }

  for (const pay of p.payments ?? []) {
    rows.push({
      atMs: pay.createdMs,
      atExact: true,
      kind: "payment",
      media: null,
      model: null,
      generationId: null,
      provider: null,
      costUsd: null,
      creditUsd: pay.creditedUsd,
      tokens: null,
      latencyMs: null,
      balanceAfterUsd: null,
      detail: `Paid $${(pay.paidCents / 100).toFixed(2)} by card`,
      reference: pay.paymentIntent,
    });
  }

  if (p.wallet.starterUsd > 0.005) {
    rows.push(openingLine("starter", p.wallet, p.wallet.starterUsd, "Starter credit"));
  }
  if (p.operatorAdjustUsd !== null && p.operatorAdjustUsd > 0.005) {
    rows.push(
      openingLine("operator-credit", p.wallet, p.operatorAdjustUsd, "Added by hand on OpenRouter"),
    );
  }

  // Refusals: ours, and the only thing here that comes from state.db.
  for (const e of p.store.eventsFor(p.wallet.sessionKey, 200)) {
    if (e.atMs < sinceMs) continue;
    rows.push({
      atMs: e.atMs,
      atExact: true,
      kind: e.kind,
      media: e.generation as GenerationKind,
      model: e.model,
      generationId: null,
      provider: null,
      costUsd: null,
      creditUsd: null,
      tokens: null,
      latencyMs: null,
      balanceAfterUsd: null,
      detail: e.detail,
      reference: null,
    });
  }

  rows.sort((a, b) => b.atMs - a.atMs || rank(a.kind) - rank(b.kind));

  // Balance after each line, walking back from what is left right now.
  if (p.remainingNowUsd !== null) {
    let running = p.remainingNowUsd;
    for (const r of rows) {
      r.balanceAfterUsd = round6(running);
      running = running + (r.costUsd ?? 0) - (r.creditUsd ?? 0);
    }
  }

  const gens = rows.filter((r) => r.kind === "generation");
  return {
    rows,
    sinceMs,
    complete,
    generations: gens.length,
    spentUsd: round6(gens.reduce((n, r) => n + (r.costUsd ?? 0), 0)),
  };
}

function openingLine(
  kind: "starter" | "operator-credit",
  wallet: Wallet,
  usd: number,
  detail: string,
): ActivityRow {
  return {
    atMs: wallet.createdAtMs,
    atExact: false,
    kind,
    media: null,
    model: null,
    generationId: null,
    provider: null,
    costUsd: null,
    creditUsd: usd,
    tokens: null,
    latencyMs: null,
    balanceAfterUsd: null,
    detail,
    reference: null,
  };
}
