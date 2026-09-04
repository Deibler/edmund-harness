import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import { CreditStore } from "../src/credits/store.ts";
import { grantDirect, syncWallet } from "../src/credits/sync.ts";

const DM = "imessage:dm:+15551230001";

function config(
  dataDir: string,
  over: Record<string, unknown> = {},
  keys: Record<string, string> = {},
) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    paths: { data_dir: dataDir },
    alerts: { operator_handle: "+15550100001" },
    keys: {
      openrouter: "sk-or-v1-house",
      openrouter_provisioning: "sk-or-prov",
      stripe_secret: "sk_live_x",
      ...keys,
    },
    credits: { enabled: true, starter_usd: 0, credit_ratio: 0.9, ...over },
  });
}

/** Fake OpenRouter (key with a limit) + fake Stripe (paid intents). */
function fakes(p: { limit: number; usage?: number; stripeCents?: number[]; stripeDown?: boolean }) {
  let limit = p.limit;
  const usage = p.usage ?? 0;
  const patches: number[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("openrouter.ai")) {
      if (method === "POST" && u.endsWith("/keys")) {
        return new Response(
          JSON.stringify({
            key: "sk-or-v1-minted",
            data: { hash: "h1", limit: 0, limit_remaining: 0, usage: 0 },
          }),
        );
      }
      if (u.endsWith("/key")) {
        return new Response(
          JSON.stringify({ data: { hash: "h1", limit, limit_remaining: limit - usage, usage } }),
        );
      }
      if (method === "PATCH") {
        limit = JSON.parse(String(init?.body)).limit;
        patches.push(limit);
        return new Response(
          JSON.stringify({ data: { hash: "h1", limit, limit_remaining: limit - usage, usage } }),
        );
      }
    }
    if (u.includes("api.stripe.com")) {
      if (p.stripeDown) return new Response("boom", { status: 500 });
      if (u.includes("/payment_intents/search")) {
        return new Response(
          JSON.stringify({
            data: (p.stripeCents ?? []).map((c, i) => ({
              id: `pi_${i}`,
              created: 100 + i,
              amount: c,
              amount_received: c,
              currency: "usd",
              status: "succeeded",
            })),
          }),
        );
      }
      if (u.includes("/checkout/sessions?payment_intent="))
        return new Response(JSON.stringify({ data: [] }));
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, patches, limit: () => limit };
}

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "credits-sync-"));
  const store = new CreditStore(dir);
  store.attachKey(DM, { hash: "h1", apiKey: "sk-or-v1-minted", limitUsd: 0, starterUsd: 0 });
  return { dir, store };
}

describe("syncWallet", () => {
  test("raises the OpenRouter limit to starter + what Stripe says was paid", async () => {
    const { dir, store } = fresh();
    const fk = fakes({ limit: 0, stripeCents: [500] });
    const v = await syncWallet({ config: config(dir), store, sessionKey: DM, fetch: fk.fetch });
    expect(v.raised).toBe(true);
    expect(v.raisedByUsd).toBe(4.5);
    expect(fk.patches).toEqual([4.5]);
    expect(v.status.limitUsd).toBe(4.5);
    expect(v.targetLimitUsd).toBe(4.5);
    expect(v.operatorAdjustUsd).toBe(0);
    store.close();
  });

  test("is idempotent: a second sync changes nothing", async () => {
    const { dir, store } = fresh();
    const fk = fakes({ limit: 4.5, stripeCents: [500] });
    const v = await syncWallet({ config: config(dir), store, sessionKey: DM, fetch: fk.fetch });
    expect(v.raised).toBe(false);
    expect(fk.patches).toEqual([]);
    store.close();
  });

  test("never lowers: an operator gift above target stays and is reported", async () => {
    const { dir, store } = fresh();
    const fk = fakes({ limit: 10, stripeCents: [500] });
    const v = await syncWallet({ config: config(dir), store, sessionKey: DM, fetch: fk.fetch });
    expect(v.raised).toBe(false);
    expect(fk.patches).toEqual([]);
    expect(v.operatorAdjustUsd).toBe(5.5);
    store.close();
  });

  test("starter credit counts toward the target", async () => {
    const { dir, store } = fresh();
    const fk = fakes({ limit: 0, stripeCents: [] });
    const v = await syncWallet({
      config: config(dir, { starter_usd: 1 }),
      store,
      sessionKey: DM,
      fetch: fk.fetch,
    });
    expect(v.raised).toBe(true);
    expect(fk.patches).toEqual([1]);
    store.close();
  });

  test("Stripe down is soft: OpenRouter's numbers still come back, nothing is patched", async () => {
    const { dir, store } = fresh();
    const fk = fakes({ limit: 2, usage: 0.5, stripeDown: true });
    const v = await syncWallet({ config: config(dir), store, sessionKey: DM, fetch: fk.fetch });
    expect(v.stripe).toBeNull();
    expect(v.raised).toBe(false);
    expect(v.status.remainingUsd).toBe(1.5);
    expect(v.targetLimitUsd).toBeNull();
    store.close();
  });

  test("no Stripe secret configured: no Stripe call at all", async () => {
    const { dir, store } = fresh();
    const fk = fakes({ limit: 3, stripeCents: [500] });
    const v = await syncWallet({
      config: config(dir, {}, { stripe_secret: "" }),
      store,
      sessionKey: DM,
      fetch: fk.fetch,
    });
    expect(v.stripe).toBeNull();
    expect(v.status.limitUsd).toBe(3);
    store.close();
  });
});

describe("grantDirect", () => {
  test("raises the key's limit on OpenRouter by the gift, recorded nowhere else", async () => {
    const { dir, store } = fresh();
    const fk = fakes({ limit: 4.5, stripeCents: [500] });
    const st = await grantDirect({
      config: config(dir),
      store,
      sessionKey: DM,
      usd: 2,
      fetch: fk.fetch,
    });
    expect(fk.patches).toEqual([6.5]);
    expect(st.limitUsd).toBe(6.5);
    // and the next sync sees the gift, does not undo it
    const v = await syncWallet({ config: config(dir), store, sessionKey: DM, fetch: fk.fetch });
    expect(v.raised).toBe(false);
    expect(v.operatorAdjustUsd).toBe(2);
    store.close();
  });
});
