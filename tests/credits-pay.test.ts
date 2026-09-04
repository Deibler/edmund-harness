import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { payRoutes } from "../dashboard/server/routes/pay.ts";
import { createTopUp, portalCreditsFor } from "../dashboard/server/services/portalCredits.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { CreditStore } from "../src/credits/store.ts";
import { computeStripeSignature } from "../src/credits/stripe.ts";
import { CronStore } from "../src/cron/store.ts";
import { b64urlEncode } from "../src/portal/token.ts";

const WHSEC = "whsec_test";
const DM = "imessage:dm:+15551230001";
const OPERATOR = "+15550100001";
const T = 1_700_000_000;

function makeConfig(
  dataDir: string,
  keys: Record<string, string> = {},
  credits: Record<string, unknown> = {},
) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    paths: { data_dir: dataDir },
    alerts: { operator_handle: OPERATOR },
    keys: {
      openrouter: "sk-or-v1-house",
      openrouter_provisioning: "sk-or-prov",
      stripe_secret: "sk_test_x",
      stripe_webhook_secret: WHSEC,
      ...keys,
    },
    credits: { enabled: true, credit_ratio: 0.9, min_topup_usd: 5, max_topup_usd: 200, ...credits },
  });
}

function checkoutEvent(id: string, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${id}`,
        amount_subtotal: 500,
        amount_total: 530,
        currency: "usd",
        payment_status: "paid",
        client_reference_id: b64urlEncode(DM),
        metadata: { session_key: DM },
        ...over,
      },
    },
  });
}

/** Fake OpenRouter + Stripe for the whole webhook → sync path. */
function fakes(p: { limit: number; sessionPaid?: boolean }) {
  let limit = p.limit;
  const patches: number[] = [];
  const calls: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u}`);
    if (u.includes("openrouter.ai")) {
      if (method === "POST" && u.endsWith("/keys")) {
        return new Response(
          JSON.stringify({
            key: "sk-or-v1-minted",
            data: { hash: "h1", limit: 0, limit_remaining: 0, usage: 0 },
          }),
        );
      }
      if (u.endsWith("/key"))
        return new Response(
          JSON.stringify({ data: { hash: "h1", limit, limit_remaining: limit, usage: 0 } }),
        );
      if (method === "PATCH") {
        limit = JSON.parse(String(init?.body)).limit;
        patches.push(limit);
        return new Response(
          JSON.stringify({ data: { hash: "h1", limit, limit_remaining: limit, usage: 0 } }),
        );
      }
    }
    if (u.includes("api.stripe.com")) {
      if (u.includes("/payment_intents/search")) return new Response(JSON.stringify({ data: [] })); // not indexed yet
      const m = u.match(/checkout\/sessions\/([^?]+)$/);
      if (m) {
        return new Response(
          JSON.stringify({
            id: decodeURIComponent(m[1]!),
            amount_subtotal: 500,
            amount_total: 530,
            currency: "usd",
            payment_status: p.sessionPaid === false ? "unpaid" : "paid",
            payment_intent: "pi_1",
            created: T,
          }),
        );
      }
      if (u.includes("/checkout/sessions?payment_intent="))
        return new Response(JSON.stringify({ data: [] }));
      if (u.endsWith("/checkout/sessions") && method === "POST") {
        const form = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify({
            id: "cs_1",
            url: `https://checkout.stripe.com/c/pay/cs_1?amt=${form.get("line_items[0][price_data][unit_amount]")}`,
          }),
        );
      }
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, patches, calls, limit: () => limit };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "credits-pay-"));
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("POST /pay/stripe", () => {
  function setup(
    opts: { limit?: number; sessionPaid?: boolean; keys?: Record<string, string> } = {},
  ) {
    const dir = scratch();
    const store = new CreditStore(dir);
    const crons = new CronStore(dir);
    const fk = fakes({ limit: opts.limit ?? 0, sessionPaid: opts.sessionPaid });
    const app = payRoutes({
      config: makeConfig(dir, opts.keys),
      store,
      crons,
      nowSec: () => T,
      fetch: fk.fetch,
    });
    const post = (body: string, sig?: string) =>
      app.request("/stripe", {
        method: "POST",
        headers: sig !== undefined ? { "stripe-signature": sig } : {},
        body,
      });
    const signed = (body: string, secret = WHSEC, t = T) =>
      `t=${t},v1=${computeStripeSignature(secret, t, body)}`;
    return { store, crons, fk, post, signed };
  }

  test("a signed checkout is confirmed with Stripe, the limit is raised, and the chat is woken", async () => {
    const { store, crons, fk, post, signed } = setup();
    const body = checkoutEvent("evt_1");
    const res = await post(body, signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    await settle();
    // it asked Stripe for the session itself rather than trusting the body
    expect(fk.calls.some((c) => c.includes("/checkout/sessions/cs_evt_1"))).toBe(true);
    // the key was minted and raised to $4.50 (500¢ pre-tax × 0.9), tax excluded
    expect(fk.patches).toEqual([4.5]);
    expect(store.get(DM)?.apiKey).toBe("sk-or-v1-minted");
    const jobs = crons.listActive(DM);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.systemEvent).toContain("[CREDITS]");
    expect(jobs[0]!.systemEvent).toContain("$4.50");
    // redelivery: Stripe says the same; nothing changes
    await post(body, signed(body));
    await settle();
    expect(fk.patches).toEqual([4.5]);
    expect(crons.listActive(DM)).toHaveLength(1);
    store.close();
    crons.close();
  });

  test("nothing is written from the event body: an unpaid session at Stripe raises nothing", async () => {
    const { fk, crons, post, signed, store } = setup({ sessionPaid: false });
    const body = checkoutEvent("evt_2"); // the body claims paid; Stripe says otherwise
    expect((await post(body, signed(body))).status).toBe(200);
    await settle();
    expect(fk.patches).toEqual([]);
    expect(crons.listActive(DM)).toHaveLength(0);
    store.close();
    crons.close();
  });

  test("unsigned, wrongly signed, tampered, and stale requests are 400 and do nothing", async () => {
    const { fk, post, signed, store, crons } = setup();
    const body = checkoutEvent("evt_3");
    expect((await post(body)).status).toBe(400);
    expect((await post(body, signed(body, "whsec_wrong"))).status).toBe(400);
    expect((await post(`${body} `, signed(body))).status).toBe(400);
    expect((await post(body, signed(body, WHSEC, T - 400))).status).toBe(400);
    await settle();
    expect(fk.calls).toEqual([]);
    store.close();
    crons.close();
  });

  test("an unset webhook secret rejects even a validly formed signature", async () => {
    const { post, signed, fk, store, crons } = setup({ keys: { stripe_webhook_secret: "" } });
    const body = checkoutEvent("evt_4");
    expect((await post(body, signed(body))).status).toBe(400);
    expect(fk.calls).toEqual([]);
    store.close();
    crons.close();
  });

  test("a checkout that names no wallet, and other event types, are acknowledged and ignored", async () => {
    const { post, signed, fk, store, crons } = setup();
    const foreign = checkoutEvent("evt_5", { metadata: {}, client_reference_id: null });
    expect(await (await post(foreign, signed(foreign))).json()).toEqual({
      received: true,
      ignored: "not a wallet checkout",
    });
    const other = JSON.stringify({
      id: "evt_6",
      type: "payment_intent.succeeded",
      data: { object: {} },
    });
    expect(await (await post(other, signed(other))).json()).toEqual({
      received: true,
      ignored: "payment_intent.succeeded",
    });
    await settle();
    expect(fk.calls).toEqual([]);
    store.close();
    crons.close();
  });
});

describe("portal credits tab data", () => {
  test("a DM's tab is a live read (minting on first view); the operator and a group get none", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    const fk = fakes({ limit: 3.5 });
    const deps = { config: makeConfig(dir), store, fetch: fk.fetch };
    const c = await portalCreditsFor(deps, DM);
    expect(c).not.toBeNull();
    expect(c!.remainingUsd).toBe(3.5);
    expect(c!.presets).toEqual([5, 10, 20]);
    expect(c!.checkoutReady).toBe(true);
    expect(c!.paidTotalUsd).toBe(0); // Stripe answered: nothing paid
    expect(store.get(DM)?.apiKey).toBe("sk-or-v1-minted");
    expect(await portalCreditsFor(deps, `imessage:dm:${OPERATOR}`)).toBeNull();
    expect(await portalCreditsFor(deps, "imessage:group:g")).toBeNull();
    store.setMode(DM, "house");
    expect(await portalCreditsFor(deps, DM)).toBeNull();
    store.close();
  });

  test("credits disabled: no tab for anyone", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    const deps = {
      config: makeConfig(dir, {}, { enabled: false }),
      store,
      fetch: fakes({ limit: 1 }).fetch,
    };
    expect(await portalCreditsFor(deps, DM)).toBeNull();
    store.close();
  });

  test("checkout enforces the amount bounds, tags the payment intent, and carries the wallet key", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    const fk = fakes({ limit: 0 });
    const deps = { config: makeConfig(dir), store, fetch: fk.fetch };
    const base = { sessionKey: DM, portalAbsUrl: "https://portal.example/u/k/t" };
    expect(await createTopUp(deps, { ...base, amountUsd: 2 })).toEqual({
      error: "minimum top-up is $5.00",
      status: 400,
    });
    expect(await createTopUp(deps, { ...base, amountUsd: 500 })).toEqual({
      error: "maximum top-up is $200.00",
      status: 400,
    });
    expect(await createTopUp(deps, { ...base, amountUsd: "abc" })).toEqual({
      error: "enter an amount",
      status: 400,
    });
    const ok = await createTopUp(deps, { ...base, amountUsd: 10 });
    expect(ok).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1?amt=1000" });
    expect(
      await createTopUp(deps, { ...base, sessionKey: "imessage:group:g", amountUsd: 10 }),
    ).toEqual({
      error: "credits are not in use for this chat",
      status: 403,
    });
    store.close();
  });

  test("checkout without a Stripe secret is a clear 503", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    const deps = {
      config: makeConfig(dir, { stripe_secret: "" }),
      store,
      fetch: fakes({ limit: 0 }).fetch,
    };
    const r = await createTopUp(deps, {
      sessionKey: DM,
      amountUsd: 10,
      portalAbsUrl: "https://p/u/k/t",
    });
    expect(r).toEqual({ error: "payments are not set up yet", status: 503 });
    store.close();
  });
});
