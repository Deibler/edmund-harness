import { Hono } from "hono";
import type { Config } from "../../../src/config/config.ts";
import { stripeCreditFor } from "../../../src/credits/ledger.ts";
import { creditsLiability } from "../../../src/credits/liability.ts";
import { updateKey } from "../../../src/credits/openrouter-keys.ts";
import { walletSessionKeyFor } from "../../../src/credits/resolve.ts";
import type { CreditStore } from "../../../src/credits/store.ts";
import { grantDirect, syncWallet } from "../../../src/credits/sync.ts";
import type { ChatDb } from "../../../src/imessage/db.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import type { StateStore } from "../../../src/sessions/store.ts";
import { buildCreditRows, enrichLive, recentPaywallEvents } from "../services/creditsOverview.ts";
import { sessionLabel } from "../services/labels.ts";
import type { CreditsOverviewDto, LiabilityDto, PaymentDto, WalletDto } from "../types.ts";

/**
 * Operator view of generation credits (PIN-gated, /api/credits).
 *
 * Every identified conversation appears (services/creditsOverview.ts). The
 * numbers are read from OpenRouter and Stripe on every request — there is
 * no local ledger to be stale. Editable here: the wallet/house override, an
 * operator gift (a direct raise of the key's limit), pausing a key.
 */
export function creditsRoutes(deps: {
  config: Config;
  store: CreditStore;
  state: StateStore;
  contacts: ContactBook;
  chatDb: ChatDb;
}): Hono {
  const app = new Hono();
  const label = (k: string) => sessionLabel(k, { contacts: deps.contacts, chatDb: deps.chatDb });

  const rows = (): WalletDto[] =>
    buildCreditRows({
      config: deps.config,
      store: deps.store,
      sessions: deps.state.listSessions(),
      label,
    });
  const rowFor = async (sessionKey: string): Promise<WalletDto | null> => {
    const r = rows().find((x) => x.sessionKey === sessionKey);
    if (!r) return null;
    await enrichLive({ config: deps.config, store: deps.store, rows: [r] });
    return r;
  };
  const overview = async (): Promise<CreditsOverviewDto> => {
    const c = deps.config.credits;
    const t0 = Date.now();
    const wallets = await enrichLive({ config: deps.config, store: deps.store, rows: rows() });
    return {
      enabled: c.enabled,
      provisioningConfigured: Boolean(deps.config.keys.openrouter_provisioning),
      stripeConfigured: Boolean(deps.config.keys.stripe_secret),
      webhookConfigured: Boolean(deps.config.keys.stripe_webhook_secret),
      operatorHandle: deps.config.alerts.operator_handle,
      settings: {
        starterUsd: c.starter_usd,
        lowWatermarkUsd: c.low_watermark_usd,
        creditRatio: c.credit_ratio,
        minTopupUsd: c.min_topup_usd,
        maxTopupUsd: c.max_topup_usd,
        presetsUsd: c.presets_usd,
      },
      wallets,
      paywall: recentPaywallEvents({ store: deps.store, label, limit: 50 }),
      liveMs: Date.now() - t0,
    };
  };
  const resolveKey = (body: { sessionKey?: unknown; handle?: unknown }): string | null => {
    if (typeof body.sessionKey === "string" && body.sessionKey.startsWith("imessage:dm:")) {
      return body.sessionKey;
    }
    if (typeof body.handle === "string" && body.handle.trim()) {
      return walletSessionKeyFor(body.handle.trim());
    }
    return null;
  };

  app.get("/", async (c) => c.json(await overview()));
  app.post("/refresh", async (c) => c.json(await overview()));

  app.post("/mode", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const key = resolveKey(body);
    if (!key) return c.json({ error: "sessionKey or handle required" }, 400);
    if (body.mode !== "wallet" && body.mode !== "house") {
      return c.json({ error: "mode must be wallet or house" }, 400);
    }
    deps.store.setMode(key, body.mode);
    return c.json({ wallet: await rowFor(key) });
  });

  app.post("/grant", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const key = resolveKey(body);
    if (!key) return c.json({ error: "sessionKey or handle required" }, 400);
    const usd = typeof body.usd === "number" ? body.usd : Number(body.usd);
    if (!(usd > 0) || usd > 1000) return c.json({ error: "usd must be between 0 and 1000" }, 400);
    try {
      const status = await grantDirect({
        config: deps.config,
        store: deps.store,
        sessionKey: key,
        usd,
      });
      return c.json({ wallet: await rowFor(key), limitUsd: status.limitUsd });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.post("/disabled", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const key = resolveKey(body);
    if (!key || typeof body.disabled !== "boolean") {
      return c.json({ error: "sessionKey and disabled required" }, 400);
    }
    const w = deps.store.get(key);
    if (!w) return c.json({ error: "no such wallet" }, 404);
    if (w.keyHash) {
      if (!deps.config.keys.openrouter_provisioning) {
        return c.json({ error: "keys.openrouter_provisioning is not set" }, 503);
      }
      try {
        await updateKey({
          provisioningKey: deps.config.keys.openrouter_provisioning,
          hash: w.keyHash,
          patch: { disabled: body.disabled },
        });
      } catch (err) {
        return c.json({ error: `OpenRouter refused: ${(err as Error).message}` }, 502);
      }
    }
    deps.store.setDisabled(key, body.disabled);
    return c.json({ wallet: await rowFor(key) });
  });

  /** One person's payments, straight from Stripe. */
  app.get("/payments", async (c) => {
    const sessionKey = c.req.query("sessionKey");
    if (!sessionKey) return c.json({ error: "sessionKey required" }, 400);
    if (!deps.config.keys.stripe_secret) return c.json({ payments: [] as PaymentDto[] });
    const credit = await stripeCreditFor({
      secret: deps.config.keys.stripe_secret,
      sessionKey,
      ratio: deps.config.credits.credit_ratio,
      withReceipts: true,
    });
    const payments: PaymentDto[] = credit.payments.map((x) => ({
      paymentIntent: x.paymentIntent,
      checkoutSession: x.checkoutSession,
      createdMs: x.createdMs,
      paidUsd: x.paidCents / 100,
      creditedUsd: x.creditedUsd,
      receiptUrl: x.receiptUrl,
      invoicePdfUrl: x.invoicePdfUrl,
    }));
    return c.json({
      payments,
      totalPaidUsd: credit.totalPaidCents / 100,
      totalCreditedUsd: credit.totalCreditedUsd,
    });
  });

  /** Force the OpenRouter limit to catch up with Stripe for one person. */
  app.post("/sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const key = resolveKey(body);
    if (!key) return c.json({ error: "sessionKey or handle required" }, 400);
    try {
      const v = await syncWallet({ config: deps.config, store: deps.store, sessionKey: key });
      return c.json({ raised: v.raised, raisedByUsd: v.raisedByUsd, wallet: await rowFor(key) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  app.get("/events", (c) => {
    const sessionKey = c.req.query("sessionKey");
    const limit = Math.min(500, Number(c.req.query("limit") ?? 100));
    const events = sessionKey
      ? deps.store.eventsFor(sessionKey, limit)
      : deps.store.recentEvents(limit, false);
    return c.json({
      events: events.map((e) => ({
        ...e,
        handle: e.sessionKey.replace(/^imessage:dm:/, ""),
        label: label(e.sessionKey),
      })),
    });
  });

  app.get("/liability", async (c) => {
    const l = await creditsLiability({ store: deps.store, houseKey: deps.config.keys.openrouter });
    const dto: LiabilityDto = { ...l, checkedAtMs: Date.now() };
    return c.json(dto);
  });

  return app;
}
