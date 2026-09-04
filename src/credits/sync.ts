import type { Config } from "../config/config.ts";
import { log } from "../util/log.ts";
import { type KnownSession, type StripeCredit, stripeCreditFor } from "./ledger.ts";
import { type FetchLike, type KeyStatus, keySelfStatus, updateKey } from "./openrouter-keys.ts";
import { ensureWalletKey } from "./provision.ts";
import type { CreditStore, Wallet } from "./store.ts";

/**
 * The one reconciliation, run on every read: make the OpenRouter key's
 * limit match what Stripe says the person has paid.
 *
 *   target = starter + Σ credited (from Stripe, live)
 *   if target > current limit → PATCH limit = target
 *
 * It only ever raises. An operator who has topped someone up by hand
 * (a direct PATCH on the key) keeps that; a refund shows up as target
 * falling below the limit, which is reported, not acted on. No local
 * table records any of it — the key IS the state, Stripe IS the ledger.
 *
 * Failure is soft on the Stripe side: if Stripe cannot be read, the caller
 * proceeds with whatever OpenRouter says the key has. Failure on the
 * OpenRouter side surfaces (nothing sensible can be shown without it).
 */

export type WalletView = {
  wallet: Wallet;
  /** Live from OpenRouter, after any raise. */
  status: KeyStatus;
  /** Live from Stripe; null when Stripe could not be read. */
  stripe: StripeCredit | null;
  /** starter + Stripe credit — what the limit should be at least. */
  targetLimitUsd: number | null;
  /** How much the operator has added by hand (limit above target), or a
   *  refund not yet reflected (negative). Null when Stripe was unreadable. */
  operatorAdjustUsd: number | null;
  /** True when this call raised the limit. */
  raised: boolean;
  raisedByUsd: number;
};

export async function syncWallet(p: {
  config: Config;
  store: CreditStore;
  sessionKey: string;
  known?: KnownSession[];
  /** Also fetch receipt/invoice links per payment (the portal wants them;
   *  the pre-generation sync does not). */
  withReceipts?: boolean;
  fetch?: FetchLike;
}): Promise<WalletView> {
  const { config } = p;
  const wallet = await ensureWalletKey({
    store: p.store,
    sessionKey: p.sessionKey,
    provisioningKey: config.keys.openrouter_provisioning,
    starterUsd: config.credits.starter_usd,
    fetch: p.fetch,
  });
  let status = await keySelfStatus({ apiKey: wallet.apiKey!, fetch: p.fetch });

  let stripe: StripeCredit | null = null;
  if (config.keys.stripe_secret) {
    try {
      stripe = await stripeCreditFor({
        secret: config.keys.stripe_secret,
        sessionKey: p.sessionKey,
        ratio: config.credits.credit_ratio,
        known: p.known,
        withReceipts: p.withReceipts ?? false,
        fetch: p.fetch,
      });
    } catch (err) {
      log.warn("credits", "stripe unreadable; using OpenRouter's limit as-is", {
        session: p.sessionKey,
        err: String(err).slice(0, 200),
      });
    }
  }

  let raised = false;
  let raisedByUsd = 0;
  let target: number | null = null;
  if (stripe) {
    target = Math.round((config.credits.starter_usd + stripe.totalCreditedUsd) * 100) / 100;
    const current = status.limitUsd ?? 0;
    if (target > current + 0.001 && wallet.keyHash && config.keys.openrouter_provisioning) {
      status = await updateKey({
        provisioningKey: config.keys.openrouter_provisioning,
        hash: wallet.keyHash,
        patch: { limitUsd: target },
        fetch: p.fetch,
      });
      raised = true;
      raisedByUsd = Math.round((target - current) * 100) / 100;
      log.info("credits", "limit raised from Stripe", {
        session: p.sessionKey,
        from: current,
        to: target,
      });
    }
  }
  // Display snapshot only — nothing decides from these columns.
  p.store.recordSeen(p.sessionKey, {
    usageUsd: status.usageUsd,
    remainingUsd: status.remainingUsd,
    limitUsd: status.limitUsd,
  });
  return {
    wallet: p.store.get(p.sessionKey) ?? wallet,
    status,
    stripe,
    targetLimitUsd: target,
    operatorAdjustUsd:
      target === null || status.limitUsd === null
        ? null
        : Math.round((status.limitUsd - target) * 100) / 100,
    raised,
    raisedByUsd,
  };
}

/** Operator gift: raise the key's limit directly on OpenRouter. Visible
 *  afterwards as `operatorAdjustUsd`; recorded nowhere else. */
export async function grantDirect(p: {
  config: Config;
  store: CreditStore;
  sessionKey: string;
  usd: number;
  fetch?: FetchLike;
}): Promise<KeyStatus> {
  if (!(p.usd > 0)) throw new Error("grant must be positive");
  if (!p.config.keys.openrouter_provisioning) {
    throw new Error("keys.openrouter_provisioning is not set");
  }
  const wallet = await ensureWalletKey({
    store: p.store,
    sessionKey: p.sessionKey,
    provisioningKey: p.config.keys.openrouter_provisioning,
    starterUsd: p.config.credits.starter_usd,
    fetch: p.fetch,
  });
  const current = await keySelfStatus({ apiKey: wallet.apiKey!, fetch: p.fetch });
  const status = await updateKey({
    provisioningKey: p.config.keys.openrouter_provisioning,
    hash: wallet.keyHash!,
    patch: { limitUsd: Math.round(((current.limitUsd ?? 0) + p.usd) * 100) / 100 },
    fetch: p.fetch,
  });
  p.store.recordSeen(p.sessionKey, {
    usageUsd: status.usageUsd,
    remainingUsd: status.remainingUsd,
    limitUsd: status.limitUsd,
  });
  log.info("credits", "operator grant", {
    session: p.sessionKey,
    usd: p.usd,
    limit: status.limitUsd,
  });
  return status;
}
