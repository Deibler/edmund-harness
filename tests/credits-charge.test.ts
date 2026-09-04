import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import { CreditsRefused, beginCharge, isPaymentRequired } from "../src/credits/billing.ts";
import { CreditStore } from "../src/credits/store.ts";

const HOUSE = "sk-or-v1-house";
const PROV = "sk-or-prov";
const MINTED = "sk-or-v1-minted";
const OPERATOR = "+15550100001";
const DM = "imessage:dm:+15551230001";

function makeConfig(
  dataDir: string,
  over: Record<string, unknown> = {},
  keys: Record<string, string> = {},
) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    paths: { data_dir: dataDir },
    alerts: { operator_handle: OPERATOR },
    dashboard: { external_url: "https://portal.example" },
    keys: { openrouter: HOUSE, openrouter_provisioning: PROV, ...keys },
    credits: { enabled: true, starter_usd: 0, low_watermark_usd: 1, ...over },
  });
}

/**
 * Fake OpenRouter for the generation path. `remaining` is what GET /key
 * reports; `usage` climbs by `spend` on each read after the first so the
 * footer can show a per-generation cost. Records every Authorization header.
 */
function fakeOpenRouter(opts: {
  remaining: number | null;
  spend?: number;
  videoPricePerSec?: number;
  after?: { remaining: number };
}) {
  const auth: string[] = [];
  const calls: string[] = [];
  let reads = 0;
  let usage = 1;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const h = (init?.headers ?? {}) as Record<string, string>;
    auth.push(h.Authorization ?? "");
    calls.push(`${method} ${u}`);
    if (method === "POST" && u.endsWith("/keys")) {
      return new Response(
        JSON.stringify({
          key: MINTED,
          data: { hash: "hash1", limit: 0, limit_remaining: 0, usage: 0 },
        }),
      );
    }
    if (method === "GET" && u.endsWith("/key")) {
      reads++;
      const remaining = reads > 1 && opts.after ? opts.after.remaining : opts.remaining;
      if (reads > 1) usage += opts.spend ?? 0;
      return new Response(
        JSON.stringify({ data: { hash: "hash1", limit: 10, limit_remaining: remaining, usage } }),
      );
    }
    if (method === "GET" && u.endsWith("/videos/models")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "google/veo-3.1",
              name: "Veo",
              pricing_skus: { "per-video-second": String(opts.videoPricePerSec ?? 0.5) },
            },
          ],
        }),
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, auth, calls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "credits-charge-"));
}

describe("beginCharge — who pays", () => {
  test("credits disabled: everyone is on the house key, no OpenRouter calls", async () => {
    const dir = scratch();
    const or = fakeOpenRouter({ remaining: 0 });
    const config = makeConfig(dir, { enabled: false });
    const c = await beginCharge({
      ctx: { config, dataDir: dir, sessionKey: DM },
      kind: "image",
      fetch: or.fetch,
    });
    expect(c.mode).toBe("house");
    expect(c.apiKey).toBe(HOUSE);
    expect(or.calls).toEqual([]);
    expect(await c.footer()).toBe("");
    expect(await c.explainFailure(new Error("generateImage 402: x"))).toBeNull();
  });

  test("the operator's DM is house even with credits on", async () => {
    const dir = scratch();
    const or = fakeOpenRouter({ remaining: 0 });
    const c = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: `imessage:dm:${OPERATOR}` },
      kind: "image",
      fetch: or.fetch,
    });
    expect(c.mode).toBe("house");
    expect(or.calls).toEqual([]);
  });

  test("a DM switched to house on the dashboard is house", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    store.setMode(DM, "house");
    const or = fakeOpenRouter({ remaining: 0 });
    const c = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
      kind: "image",
      fetch: or.fetch,
      store,
    });
    expect(c.mode).toBe("house");
    expect(c.apiKey).toBe(HOUSE);
    store.close();
  });

  test("a group is house", async () => {
    const dir = scratch();
    const or = fakeOpenRouter({ remaining: 0 });
    const c = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: "imessage:group:abc" },
      kind: "image",
      fetch: or.fetch,
    });
    expect(c.mode).toBe("house");
  });
});

describe("beginCharge — a person's wallet", () => {
  test("first use mints a key with the starter limit; an empty balance is refused with the top-up link", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    const or = fakeOpenRouter({ remaining: 0 });
    let err: unknown;
    try {
      await beginCharge({
        ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
        kind: "image",
        fetch: or.fetch,
        store,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CreditsRefused);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^GENERATION REFUSED/);
    expect(msg).toContain("used up");
    expect(msg).toContain("https://portal.example/u/");
    expect(msg).toContain("#credits");
    expect(msg).toContain("Do not retry");
    // the key was minted with the provisioning key and persisted
    expect(or.calls[0]).toBe("POST https://openrouter.ai/api/v1/keys");
    expect(or.auth[0]).toBe(`Bearer ${PROV}`);
    const w = store.get(DM)!;
    expect(w.apiKey).toBe(MINTED);
    expect(w.keyHash).toBe("hash1");
    // and the house key never authenticated anything
    expect(or.auth).not.toContain(`Bearer ${HOUSE}`);
    // the paywall hit is on record for the dashboard
    const events = store.eventsFor(DM);
    expect(events.map((e) => [e.kind, e.generation])).toEqual([["refused-exhausted", "image"]]);
    expect(events[0]!.remainingUsd).toBe(0);
    store.close();
  });

  test("with balance, generation runs on the wallet key and the footer reports what is left", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    store.attachKey(DM, { hash: "hash1", apiKey: MINTED, limitUsd: 10, starterUsd: 0 });
    const or = fakeOpenRouter({ remaining: 5, spend: 0.05, after: { remaining: 4.95 } });
    const c = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
      kind: "image",
      fetch: or.fetch,
      store,
    });
    expect(c.mode).toBe("wallet");
    expect(c.apiKey).toBe(MINTED);
    expect(c.remainingBeforeUsd).toBe(5);
    expect(or.calls.some((x) => x.startsWith("POST"))).toBe(false); // no re-mint
    const footer = await c.footer();
    expect(footer).toContain("$4.95 of the user's generation credit remains");
    expect(footer).toContain("cost about $0.05");
    expect(footer).not.toContain("LOW CREDIT");
    // Nothing is written down about a generation that went through —
    // OpenRouter is the record of it (activity.ts reads it back).
    expect(store.eventsFor(DM)).toHaveLength(0);
    store.close();
  });

  test("under the watermark the footer carries the LOW nudge and the link", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    store.attachKey(DM, { hash: "hash1", apiKey: MINTED, limitUsd: 10, starterUsd: 0 });
    const or = fakeOpenRouter({ remaining: 1.2, spend: 0.4, after: { remaining: 0.8 } });
    const c = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
      kind: "image",
      fetch: or.fetch,
      store,
    });
    const footer = await c.footer();
    expect(footer).toContain("LOW CREDIT");
    expect(footer).toContain("under $1.00");
    expect(footer).toContain("#credits");
    store.close();
  });

  test("a 402 with the wallet empty explains exhaustion; with balance intact it blames the account", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    store.attachKey(DM, { hash: "hash1", apiKey: MINTED, limitUsd: 10, starterUsd: 0 });
    const empty = fakeOpenRouter({ remaining: 2, after: { remaining: 0 } });
    const c1 = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
      kind: "image",
      fetch: empty.fetch,
      store,
    });
    const why1 = await c1.explainFailure(new Error("generateImage 402: insufficient credits"));
    expect(why1).toContain("used up");
    expect(why1).toContain("#credits");

    const intact = fakeOpenRouter({ remaining: 4, after: { remaining: 4 } });
    const c2 = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
      kind: "image",
      fetch: intact.fetch,
      store,
    });
    const why2 = await c2.explainFailure(new Error("generateImage 402: insufficient credits"));
    expect(why2).toContain("ACCOUNT level");
    expect(why2).toContain("Do not send them a top-up link");

    const c3 = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
      kind: "image",
      fetch: intact.fetch,
      store,
    });
    expect(await c3.explainFailure(new Error("generateImage 500: upstream"))).toBeNull();
    store.close();
  });

  test("a video the balance cannot cover is refused before any render, with the estimate", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    store.attachKey(DM, { hash: "hash1", apiKey: MINTED, limitUsd: 10, starterUsd: 0 });
    const or = fakeOpenRouter({ remaining: 3, videoPricePerSec: 0.5 });
    // listVideoModels uses the global fetch
    globalThis.fetch = or.fetch;
    let err: unknown;
    try {
      await beginCharge({
        ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
        kind: "video",
        video: { model: "google/veo-3.1", durationS: 8 },
        fetch: or.fetch,
        store,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CreditsRefused);
    expect((err as Error).message).toContain("would cost about $4.00");
    expect((err as Error).message).toContain("$3.00 of generation credit left");
    // and a clip that fits goes through
    const ok = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
      kind: "video",
      video: { model: "google/veo-3.1", durationS: 4 },
      fetch: or.fetch,
      store,
    });
    expect(ok.mode).toBe("wallet");
    const shorts = store.eventsFor(DM).filter((e) => e.kind === "refused-short");
    expect(shorts).toHaveLength(1);
    expect(shorts[0]!.generation).toBe("video");
    expect(shorts[0]!.detail).toContain("$4.00");
    store.close();
  });

  test("no provisioning key: refused as unavailable, never falls back to the house key", async () => {
    const dir = scratch();
    const or = fakeOpenRouter({ remaining: 0 });
    const config = makeConfig(dir, {}, { openrouter_provisioning: "" });
    let err: unknown;
    try {
      await beginCharge({
        ctx: { config, dataDir: dir, sessionKey: DM },
        kind: "image",
        fetch: or.fetch,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CreditsRefused);
    expect((err as Error).message).toContain("could not be reached");
    expect((err as Error).message).toContain("not the user's balance");
    expect(or.calls).toEqual([]);
  });

  test("a paused wallet is refused as paused", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    store.attachKey(DM, { hash: "hash1", apiKey: MINTED, limitUsd: 10, starterUsd: 0 });
    store.setDisabled(DM, true);
    const or = fakeOpenRouter({ remaining: 5 });
    await expect(
      beginCharge({
        ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: DM },
        kind: "image",
        fetch: or.fetch,
        store,
      }),
    ).rejects.toThrow(/paused/);
    store.close();
  });

  test("an SMS DM and the iMessage DM for the same handle draw on one wallet", async () => {
    const dir = scratch();
    const store = new CreditStore(dir);
    store.attachKey(DM, { hash: "hash1", apiKey: MINTED, limitUsd: 10, starterUsd: 0 });
    const or = fakeOpenRouter({ remaining: 5 });
    const c = await beginCharge({
      ctx: { config: makeConfig(dir), dataDir: dir, sessionKey: "sms:dm:+15551230001" },
      kind: "audio",
      fetch: or.fetch,
      store,
    });
    expect(c.apiKey).toBe(MINTED);
    expect(store.list()).toHaveLength(1);
    store.close();
  });
});

describe("isPaymentRequired", () => {
  test("recognises OpenRouter's 402 shapes and nothing else", () => {
    expect(isPaymentRequired(new Error('generateImage 402: {"error":{"code":402}}'))).toBe(true);
    expect(isPaymentRequired(new Error("Insufficient credits. Add more"))).toBe(true);
    expect(isPaymentRequired(new Error("generateVideo submit 500: boom"))).toBe(false);
    expect(isPaymentRequired(new Error("timed out after 4020ms"))).toBe(false);
  });
});
