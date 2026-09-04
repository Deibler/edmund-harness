import { AgentStore } from "../agents/store.ts";
import type { Config } from "../config/config.ts";
import { loadPortalSecret, portalUrl } from "../portal/token.ts";
import * as or from "../tools/openrouter-http.ts";
import { log } from "../util/log.ts";
import { generationDetail } from "./analytics.ts";
import type { FetchLike, KeyStatus } from "./openrouter-keys.ts";
import { CreditsUnavailable, ensureWalletKey, refreshWalletStatus } from "./provision.ts";
import { resolveBillingSession } from "./resolve.ts";
import { type CreditEventKind, CreditStore, type Wallet } from "./store.ts";
import { syncWallet } from "./sync.ts";

/**
 * Charging a generation to the right key — the one seam the three
 * generation executors call.
 *
 *   const charge = await beginCharge({ ctx, kind: "image" });   // may refuse
 *   … generate with charge.apiKey …
 *   on error:   const why = await charge.explainFailure(err); if (why) throw new Error(why);
 *   on success: summary += await charge.footer();
 *
 * `beginCharge` decides house-vs-wallet through the shared resolver, mints
 * a key on first use, then reads the person's balance the only way that is
 * ever done: live. OpenRouter says what the key has; Stripe says what they
 * have paid; if Stripe says more than the key allows, the limit is raised
 * right here, before the pre-flight (sync.ts). So a payment made a moment
 * ago counts on this very generation even if no webhook ever arrived.
 *
 * Every refusal is a thrown CreditsRefused whose message is written FOR THE
 * MODEL: what happened, what not to do (retry), and what to send (the
 * portal link). The model always replies; only the generation is withheld.
 */

export type GenerationKind = "image" | "video" | "audio";

export type ChargeContext = { config: Config; dataDir: string; sessionKey: string };

export type Charge = {
  mode: "house" | "wallet";
  apiKey: string;
  /** The person's portal link, Credits tab. Null in house mode. */
  topUpUrl: string | null;
  /** Live balance read before generating; null when unknown or house. */
  remainingBeforeUsd: number | null;
  /** Non-null when the failure was about money — a model-facing message. */
  explainFailure: (err: unknown) => Promise<string | null>;
  /** Block appended to the success summary. "" in house mode. Pass what ran
   *  so the activity log can read its cost back from OpenRouter later. */
  footer: (meta?: ChargeMeta) => Promise<string>;
};

export type ChargeMeta = { model?: string; generationId?: string | null };

export class CreditsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditsRefused";
  }
}

export const REFUSED_PREFIX = "GENERATION REFUSED";

/** Balances at or under this read as empty — OpenRouter bills fractions of
 *  a cent and a $0.003 remainder cannot buy anything. */
const EMPTY_USD = 0.01;
/** Default clip length when the model did not pass one (Veo's default). */
const DEFAULT_VIDEO_SECONDS = 8;

export function exhaustedMessage(topUpUrl: string, remainingUsd: number | null): string {
  const left = remainingUsd === null ? "$0.00" : usd(Math.max(0, remainingUsd));
  return [
    `${REFUSED_PREFIX} — the user's generation credit is used up (${left} left). Do not retry and do not try another model.`,
    "Tell them plainly, in one or two lines, that images, videos and audio run on prepaid credit and theirs is empty, and send this link so they can add some:",
    topUpUrl,
    "Everything else you do for them is unaffected.",
  ].join("\n");
}

export function shortForVideoMessage(
  topUpUrl: string,
  remainingUsd: number,
  estimateUsd: number,
): string {
  return [
    `${REFUSED_PREFIX} — this video would cost about ${usd(estimateUsd)} and the user has ${usd(remainingUsd)} of generation credit left. Do not retry as-is.`,
    `Tell them in one or two lines. Their options: a shorter or cheaper clip that fits ${usd(remainingUsd)}, or adding credit here:`,
    topUpUrl,
  ].join("\n");
}

export function unavailableMessage(detail: string): string {
  return [
    `${REFUSED_PREFIX} — the credits system could not be reached (${detail}).`,
    "This is not the user's balance and not their fault. Tell them in one line to try again in a few minutes. Do not retry now.",
  ].join("\n");
}

export function disabledMessage(): string {
  return [
    `${REFUSED_PREFIX} — the operator has paused this person's generation key.`,
    "Do not retry. Tell them in one line that generation is paused for them right now and the operator can turn it back on.",
  ].join("\n");
}

export function accountOutMessage(remainingUsd: number | null): string {
  const theirs = remainingUsd === null ? "their credit" : `their ${usd(remainingUsd)} of credit`;
  return [
    `${REFUSED_PREFIX} — OpenRouter refused payment at the ACCOUNT level, not this person's balance (${theirs} is intact). Do not send them a top-up link.`,
    "Tell them in one line that the generation service is out of funds on the operator's side and you've flagged it. The operator has been alerted.",
  ].join("\n");
}

/** A 402 from OpenRouter, whichever call raised it. */
export function isPaymentRequired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b402\b/.test(msg) || /insufficient credits/i.test(msg) || /payment.required/i.test(msg);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function agentParentLookup(dataDir: string): (id: string) => string | null {
  return (id) => {
    try {
      // AgentStore has no close(); the handle is short-lived and the process
      // (MCP subprocess / bg-runner) is too.
      return new AgentStore(dataDir).get(id)?.parentSessionKey ?? null;
    } catch {
      return null;
    }
  };
}

/** Per-second price × seconds, from the live model list. Null when the
 *  model is unknown or unpriced — the caller then relies on OpenRouter's
 *  own enforcement rather than refusing on a guess. */
export async function estimateVideoUsd(p: {
  apiKey: string;
  model: string;
  durationS: number | undefined;
}): Promise<number | null> {
  try {
    const models = await or.listVideoModels(p.apiKey);
    const m = models.find((x) => x.id === p.model);
    if (!m?.price || m.price.unit !== "USD/second") return null;
    return m.price.amount * (p.durationS ?? DEFAULT_VIDEO_SECONDS);
  } catch {
    return null;
  }
}

function houseCharge(config: Config): Charge {
  const apiKey = config.keys.openrouter;
  if (!apiKey) throw new Error("config.keys.openrouter is not set");
  return {
    mode: "house",
    apiKey,
    topUpUrl: null,
    remainingBeforeUsd: null,
    explainFailure: async () => null,
    footer: async () => "",
  };
}

export async function beginCharge(p: {
  ctx: ChargeContext;
  kind: GenerationKind;
  /** Video only: lets the pre-flight price the clip. */
  video?: { model: string; durationS: number | undefined };
  fetch?: FetchLike;
  /** Injectable for tests; when omitted, opened on state.db and closed here. */
  store?: CreditStore;
  parentOf?: (agentId: string) => string | null;
}): Promise<Charge> {
  const { config, dataDir, sessionKey } = p.ctx;
  if (!config.credits.enabled) return houseCharge(config);

  const store = p.store ?? new CreditStore(dataDir);
  const ownStore = !p.store;
  const closeStore = () => {
    if (ownStore) {
      try {
        store.close();
      } catch {}
    }
  };

  const target = resolveBillingSession(sessionKey, {
    operatorHandle: config.alerts.operator_handle,
    modeOf: (k) => store.get(k)?.billingMode ?? null,
    parentOf: p.parentOf ?? agentParentLookup(dataDir),
  });
  if (target.kind === "house") {
    closeStore();
    return houseCharge(config);
  }

  // Every refusal and every charged generation leaves a row the dashboard
  // shows ("who hit the paywall, when, for what"). Best-effort: a failed
  // write must never turn into a refusal of its own.
  const note = (
    kind: CreditEventKind,
    extra: {
      remainingUsd?: number | null;
      costUsd?: number | null;
      detail?: string | null;
      model?: string | null;
      generationId?: string | null;
    } = {},
  ) => {
    try {
      store.recordEvent({
        sessionKey: target.sessionKey,
        kind,
        generation: p.kind,
        model: extra.model ?? p.video?.model ?? null,
        ...extra,
      });
    } catch (err) {
      log.warn("credits", "could not record event", { kind, err: String(err) });
    }
  };

  let wallet: Wallet;
  try {
    wallet = await ensureWalletKey({
      store,
      sessionKey: target.sessionKey,
      provisioningKey: config.keys.openrouter_provisioning,
      starterUsd: config.credits.starter_usd,
      fetch: p.fetch,
    });
  } catch (err) {
    const detail = err instanceof CreditsUnavailable ? err.message : String(err);
    note("refused-unavailable", { detail });
    closeStore();
    log.error("credits", "wallet unavailable", { session: target.sessionKey, detail });
    throw new CreditsRefused(unavailableMessage(detail));
  }
  const apiKey = wallet.apiKey!;
  const topUpUrl = `${portalUrl(config, loadPortalSecret(dataDir), target.sessionKey)}#credits`;

  // Live: what the key has (OpenRouter) after catching up with what they
  // have paid (Stripe). If either provider is unreadable we still generate
  // — OpenRouter enforces the limit regardless — with an unknown balance.
  let before: KeyStatus | null = null;
  try {
    const v = await syncWallet({ config, store, sessionKey: target.sessionKey, fetch: p.fetch });
    before = v.status;
    wallet = v.wallet;
  } catch (err) {
    log.warn("credits", "balance unreadable before generation", {
      session: target.sessionKey,
      err: String(err).slice(0, 200),
    });
    before = await refreshWalletStatus({ store, wallet, fetch: p.fetch });
  }

  if (wallet.disabled || before?.disabled) {
    note("refused-disabled", { remainingUsd: before?.remainingUsd ?? null });
    closeStore();
    throw new CreditsRefused(disabledMessage());
  }
  const remaining = before?.remainingUsd ?? null;
  if (remaining !== null) {
    if (remaining <= EMPTY_USD) {
      note("refused-exhausted", { remainingUsd: remaining });
      closeStore();
      throw new CreditsRefused(exhaustedMessage(topUpUrl, remaining));
    }
    if (p.kind === "video" && p.video) {
      const estimate = await estimateVideoUsd({ apiKey, ...p.video });
      if (estimate !== null && remaining < estimate) {
        note("refused-short", {
          remainingUsd: remaining,
          detail: `needs about $${estimate.toFixed(2)} for ${p.video.durationS ?? DEFAULT_VIDEO_SECONDS}s of ${p.video.model}`,
        });
        closeStore();
        throw new CreditsRefused(shortForVideoMessage(topUpUrl, remaining, estimate));
      }
    }
  }

  const watermark = config.credits.low_watermark_usd;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    closeStore();
  };

  return {
    mode: "wallet",
    apiKey,
    topUpUrl,
    remainingBeforeUsd: remaining,
    explainFailure: async (err) => {
      try {
        if (!isPaymentRequired(err)) return null;
        const after = await refreshWalletStatus({ store, wallet, fetch: p.fetch });
        const left = after?.remainingUsd ?? null;
        if (left === null || left <= EMPTY_USD) {
          note("refused-exhausted", {
            remainingUsd: left,
            detail: "402 from OpenRouter mid-generation",
          });
          return exhaustedMessage(topUpUrl, left);
        }
        // The key still has room, so the 402 came from the account that
        // funds it. That is the operator's problem, and a top-up link
        // would charge the wrong person for it.
        log.error("credits", "402 with wallet balance intact — account-level", {
          session: target.sessionKey,
          remaining: left,
        });
        note("refused-account", { remainingUsd: left });
        return accountOutMessage(left);
      } finally {
        settle();
      }
    },
    footer: async (meta) => {
      try {
        const after = await refreshWalletStatus({ store, wallet, fetch: p.fetch });
        if (!after || after.remainingUsd === null) {
          return "\n\nCredits: the user's balance could not be read just now; it is drawn from their prepaid generation credit.";
        }
        // OpenRouter's own figure for this generation when it has one, else
        // the movement on the key. Nothing is written down about it: the
        // person's statement reads it back from OpenRouter (activity.ts).
        let spent: number | null = null;
        if (meta?.generationId) {
          try {
            const g = await generationDetail({ apiKey, id: meta.generationId, fetch: p.fetch });
            spent = g?.costUsd ?? null;
          } catch {
            // fall through to the measured delta
          }
        }
        if (spent === null) {
          const delta = before ? after.usageUsd - before.usageUsd : 0;
          spent = delta > 0.0005 ? delta : null;
        }
        const cost = spent !== null ? ` This one cost about ${usd(spent)}.` : "";
        const lines = [
          `\n\nCredits: ${usd(after.remainingUsd)} of the user's generation credit remains.${cost}`,
        ];
        if (after.remainingUsd < watermark) {
          lines.push(
            `LOW CREDIT — under ${usd(watermark)}. When you deliver this, mention it in one line and include their top-up link: ${topUpUrl}`,
          );
        }
        return lines.join("\n");
      } finally {
        settle();
      }
    },
  };
}

/** Body of the wake-up the session gets after a top-up raised their limit.
 *  The model decides whether to speak. */
export function paymentAppliedEvent(p: { creditedUsd: number; status: KeyStatus }): string {
  const balance = p.status.remainingUsd === null ? "unknown" : usd(p.status.remainingUsd);
  return [
    `[CREDITS] The user just added ${usd(p.creditedUsd)} of generation credit. Their balance is now ${balance}.`,
    "If they were waiting on an image, video or audio you refused for lack of credit, make it now.",
    "Otherwise: one short line of thanks at most — or nothing at all if the conversation has moved on. Never send a status note for its own sake.",
  ].join("\n");
}
