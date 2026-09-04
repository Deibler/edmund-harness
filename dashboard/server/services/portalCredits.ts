import type { Config } from "../../../src/config/config.ts";
import { type Activity, type ActivityRow, walletActivity } from "../../../src/credits/activity.ts";
import type { FetchLike } from "../../../src/credits/openrouter-keys.ts";
import { ensureWalletKey } from "../../../src/credits/provision.ts";
import { resolveBillingSession } from "../../../src/credits/resolve.ts";
import type { CreditStore } from "../../../src/credits/store.ts";
import { createCheckoutSession } from "../../../src/credits/stripe.ts";
import { syncWallet } from "../../../src/credits/sync.ts";
import { b64urlEncode } from "../../../src/portal/token.ts";

/**
 * The Credits tab of the USER portal — data and the one action (checkout).
 *
 * Every open reads live: the balance from OpenRouter with the person's own
 * key, the payments and receipts from Stripe by the tag on each one, and
 * any gap between what was paid and what the key allows is closed on the
 * spot (sync.ts). The statement — every generation with OpenRouter's cost
 * and time, every payment, the balance after each — is a second, slower
 * read (`portalActivityFor`) the page fetches after it has rendered.
 * Nothing is served from a local ledger. Returns null for anyone who has
 * nothing to pay for: credits disabled, a group, the operator, or a DM
 * switched to `house`.
 */

export type PortalCreditPayment = {
  atMs: number;
  paidUsd: number;
  creditedUsd: number;
  paymentIntent: string;
  receiptUrl: string | null;
  invoicePdfUrl: string | null;
  invoiceUrl: string | null;
};

export type PortalActivityRow = ActivityRow;
export type PortalActivity = Activity;

export type PortalCredits = {
  remainingUsd: number | null;
  usageUsd: number | null;
  limitUsd: number | null;
  /** From Stripe. Null when Stripe could not be read this time. */
  paidTotalUsd: number | null;
  creditedTotalUsd: number | null;
  /** Credit above what payments account for — a gift from the operator. */
  operatorCreditUsd: number | null;
  presets: number[];
  minTopup: number;
  maxTopup: number;
  ratio: number;
  disabled: boolean;
  /** Set when the live balance could not be read or the key could not be minted. */
  unavailable: string | null;
  payments: PortalCreditPayment[];
  /** Whether a card checkout can actually be started right now. */
  checkoutReady: boolean;
};

type Deps = { config: Config; store: CreditStore; fetch?: FetchLike };

function walletTarget(deps: Deps, sessionKey: string): string | null {
  if (!deps.config.credits.enabled) return null;
  const target = resolveBillingSession(sessionKey, {
    operatorHandle: deps.config.alerts.operator_handle,
    modeOf: (k) => deps.store.get(k)?.billingMode ?? null,
    parentOf: () => null,
  });
  return target.kind === "wallet" ? target.sessionKey : null;
}

export async function portalCreditsFor(
  deps: Deps,
  sessionKey: string,
): Promise<PortalCredits | null> {
  const walletKey = walletTarget(deps, sessionKey);
  if (!walletKey) return null;
  const cfg = deps.config.credits;
  const base: PortalCredits = {
    remainingUsd: null,
    usageUsd: null,
    limitUsd: null,
    paidTotalUsd: null,
    creditedTotalUsd: null,
    operatorCreditUsd: null,
    presets: cfg.presets_usd,
    minTopup: cfg.min_topup_usd,
    maxTopup: cfg.max_topup_usd,
    ratio: cfg.credit_ratio,
    disabled: false,
    unavailable: null,
    payments: [],
    checkoutReady: Boolean(deps.config.keys.stripe_secret),
  };
  try {
    const v = await syncWallet({
      config: deps.config,
      store: deps.store,
      sessionKey: walletKey,
      withReceipts: true,
      fetch: deps.fetch,
    });
    return {
      ...base,
      remainingUsd: v.status.remainingUsd,
      usageUsd: v.status.usageUsd,
      limitUsd: v.status.limitUsd,
      paidTotalUsd: v.stripe ? v.stripe.totalPaidCents / 100 : null,
      creditedTotalUsd: v.stripe ? v.stripe.totalCreditedUsd : null,
      operatorCreditUsd:
        v.operatorAdjustUsd !== null && v.operatorAdjustUsd > 0 ? v.operatorAdjustUsd : null,
      disabled: v.wallet.disabled || v.status.disabled,
      unavailable: v.stripe ? null : "payment history could not be read from Stripe just now",
      payments: (v.stripe?.payments ?? []).map((p) => ({
        atMs: p.createdMs,
        paidUsd: p.paidCents / 100,
        creditedUsd: p.creditedUsd,
        paymentIntent: p.paymentIntent,
        receiptUrl: p.receiptUrl,
        invoicePdfUrl: p.invoicePdfUrl,
        invoiceUrl: p.invoiceUrl,
      })),
    };
  } catch (err) {
    return { ...base, unavailable: (err as Error).message };
  }
}

/** The statement: OpenRouter's generations, Stripe's payments, our
 *  refusals, and the balance after each line. Null for anyone without a
 *  wallet. Throws when OpenRouter's history cannot be read at all. */
export async function portalActivityFor(
  deps: Deps,
  sessionKey: string,
): Promise<PortalActivity | null> {
  const walletKey = walletTarget(deps, sessionKey);
  if (!walletKey) return null;
  const v = await syncWallet({
    config: deps.config,
    store: deps.store,
    sessionKey: walletKey,
    fetch: deps.fetch,
  });
  return walletActivity({
    managementKey: deps.config.keys.openrouter_provisioning,
    store: deps.store,
    wallet: v.wallet,
    payments: v.stripe?.payments ?? null,
    remainingNowUsd: v.status.remainingUsd,
    operatorAdjustUsd: v.operatorAdjustUsd,
    fetch: deps.fetch,
  });
}

export type TopUpResult = { url: string } | { error: string; status: 400 | 403 | 503 };

/** Start a Stripe Checkout for this person. `portalAbsUrl` is the absolute
 *  portal link — Stripe needs somewhere real to send them back to. */
export async function createTopUp(
  deps: Deps,
  p: { sessionKey: string; amountUsd: unknown; portalAbsUrl: string },
): Promise<TopUpResult> {
  const walletKey = walletTarget(deps, p.sessionKey);
  if (!walletKey) return { error: "credits are not in use for this chat", status: 403 };
  if (!deps.config.keys.stripe_secret) return { error: "payments are not set up yet", status: 503 };
  const cfg = deps.config.credits;
  const amount = typeof p.amountUsd === "number" ? p.amountUsd : Number(p.amountUsd);
  if (!Number.isFinite(amount)) return { error: "enter an amount", status: 400 };
  if (amount < cfg.min_topup_usd) {
    return { error: `minimum top-up is $${cfg.min_topup_usd.toFixed(2)}`, status: 400 };
  }
  if (amount > cfg.max_topup_usd) {
    return { error: `maximum top-up is $${cfg.max_topup_usd.toFixed(2)}`, status: 400 };
  }
  try {
    await ensureWalletKey({
      store: deps.store,
      sessionKey: walletKey,
      provisioningKey: deps.config.keys.openrouter_provisioning,
      starterUsd: cfg.starter_usd,
      fetch: deps.fetch,
    });
  } catch (err) {
    return { error: `credits unavailable: ${(err as Error).message}`, status: 503 };
  }
  try {
    const session = await createCheckoutSession({
      secretKey: deps.config.keys.stripe_secret,
      amountCents: Math.round(amount * 100),
      clientReferenceId: b64urlEncode(walletKey),
      sessionKey: walletKey,
      productName: cfg.product_name,
      productId: cfg.stripe_product_id || undefined,
      taxCode: cfg.stripe_tax_code || undefined,
      successUrl: `${p.portalAbsUrl}?paid=1#credits`,
      cancelUrl: `${p.portalAbsUrl}#credits`,
      fetch: deps.fetch,
    });
    return { url: session.url };
  } catch (err) {
    console.error("[portal] stripe checkout failed:", err);
    return { error: "could not start checkout — try again in a moment", status: 503 };
  }
}
