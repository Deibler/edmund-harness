import { Hono } from "hono";
import type { Config } from "../../../src/config/config.ts";
import { paymentAppliedEvent } from "../../../src/credits/billing.ts";
import { retrieveCheckoutSession } from "../../../src/credits/ledger.ts";
import type { CreditStore } from "../../../src/credits/store.ts";
import {
  explainStripeSignature,
  parseCheckoutCompleted,
  sessionKeyFromCheckout,
  stripeEventType,
} from "../../../src/credits/stripe.ts";
import { syncWallet } from "../../../src/credits/sync.ts";
import type { CronStore } from "../../../src/cron/store.ts";

/**
 * Stripe webhook — mounted on the PUBLIC listener at /pay/stripe.
 *
 * It is a TRIGGER, not a ledger. Nothing from the event body is recorded.
 * After the signature checks out we answer 200, then ask Stripe for that
 * Checkout Session ourselves, run the same sync every page view and
 * generation runs (sync.ts), and if the limit went up, wake the person's
 * conversation so Edmund can finish what he refused. A delivery that never
 * arrives costs nothing but that nudge: the next page view or generation
 * reads Stripe directly and raises the limit anyway.
 */
export function payRoutes(deps: {
  config: Config;
  store: CreditStore;
  crons: CronStore;
  /** Injectable clock for signature-tolerance tests. */
  nowSec?: () => number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}): Hono {
  const app = new Hono();

  app.post("/stripe", async (c) => {
    const raw = await c.req.text();
    const verdict = explainStripeSignature({
      secret: deps.config.keys.stripe_webhook_secret,
      header: c.req.header("stripe-signature"),
      rawBody: raw,
      nowSec: deps.nowSec?.(),
    });
    if (!verdict.ok) {
      // Reason only — never the body or the secret. "mismatch" with small
      // skew means the configured secret is not the endpoint's, or the
      // bytes changed in transit; "stale" means the clock.
      const skew = verdict.skewSec !== undefined ? ` skew_s=${verdict.skewSec}` : "";
      const bytes = verdict.bodyBytes !== undefined ? ` body_bytes=${verdict.bodyBytes}` : "";
      const ua = JSON.stringify(c.req.header("user-agent") ?? "");
      console.warn(
        `[pay] stripe webhook signature rejected reason=${verdict.reason}${skew}${bytes} ua=${ua}`,
      );
      return c.text("bad signature", 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("bad json", 400);
    }
    const type = stripeEventType(body);
    if (type === "checkout.session.completed") {
      const ev = parseCheckoutCompleted(body);
      const sessionKey = ev ? sessionKeyFromCheckout(ev) : null;
      if (!ev || !sessionKey) return c.json({ received: true, ignored: "not a wallet checkout" });
      console.log(`[pay] checkout ${ev.checkoutSessionId} for ${sessionKey} — syncing from Stripe`);
      setTimeout(() => void syncAfterPayment(deps, sessionKey, ev.checkoutSessionId), 0);
      return c.json({ received: true });
    }
    if (type === "charge.refunded") {
      // v1: a human lowers the wallet's limit. The sync never lowers on its own.
      console.warn(
        "[pay] charge.refunded received — lower the wallet limit by hand (Credits page)",
      );
      return c.json({ received: true, action: "manual" });
    }
    return c.json({ received: true, ignored: type });
  });

  return app;
}

async function syncAfterPayment(
  deps: { config: Config; store: CreditStore; crons: CronStore; fetch?: typeof fetch },
  sessionKey: string,
  checkoutSession: string,
): Promise<void> {
  try {
    // Confirm with Stripe rather than trusting the body, and hand the
    // confirmed session to the sync in case search has not indexed it yet.
    const known = await retrieveCheckoutSession({
      secret: deps.config.keys.stripe_secret,
      id: checkoutSession,
      fetch: deps.fetch,
    });
    const view = await syncWallet({
      config: deps.config,
      store: deps.store,
      sessionKey,
      known: known ? [known] : [],
      fetch: deps.fetch,
    });
    if (view.raised) {
      console.log(
        `[pay] limit raised +$${view.raisedByUsd.toFixed(2)} for ${sessionKey} (remaining $${view.status.remainingUsd?.toFixed(2) ?? "?"})`,
      );
      deps.crons.create({
        sessionKey,
        systemEvent: paymentAppliedEvent({ creditedUsd: view.raisedByUsd, status: view.status }),
        schedule: { kind: "once", atMs: Date.now() + 2_000 },
      });
    } else {
      console.log(`[pay] ${sessionKey} already up to date (limit $${view.status.limitUsd ?? "?"})`);
    }
  } catch (err) {
    console.error(`[pay] sync after payment failed for ${sessionKey}:`, err);
  }
}
