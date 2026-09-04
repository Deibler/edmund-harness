import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaKindOf, walletActivity } from "../src/credits/activity.ts";
import type { StripePayment } from "../src/credits/ledger.ts";
import { CreditStore } from "../src/credits/store.ts";

const DM = "imessage:dm:+15551230001";
const HASH = "6b9294c1".padEnd(64, "0");
const NOW = Date.parse("2026-09-02T18:00:00Z");
const DAY = 86_400_000;

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "credits-activity-"));
  const store = new CreditStore(dir);
  store.attachKey(DM, { hash: HASH, apiKey: "sk-or-v1-user", limitUsd: 4.5, starterUsd: 0 });
  return store;
}

function payment(over: Partial<StripePayment> = {}): StripePayment {
  return {
    paymentIntent: "pi_1",
    checkoutSession: "cs_1",
    createdMs: Date.parse("2026-09-02T15:50:00Z"),
    paidCents: 530,
    subtotalCents: 500,
    creditedUsd: 4.5,
    currency: "usd",
    receiptUrl: null,
    invoicePdfUrl: null,
    invoiceUrl: null,
    ...over,
  };
}

/** OpenRouter: two generations on the key this hour; the newer one has a
 *  full record, the older one is not filed yet (404). */
function fakeOpenRouter() {
  const auth: Array<[string, string]> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    auth.push([u.replace(/\?.*/, ""), (init?.headers as Record<string, string>).Authorization]);
    if (u.endsWith("/analytics/query")) {
      const body = JSON.parse(String(init?.body)) as { filters: unknown };
      expect(body.filters).toEqual([{ field: "api_key_id", operator: "eq", value: HASH }]);
      return new Response(
        JSON.stringify({
          data: {
            data: [
              {
                created_at__hour: "2026-09-02 16:00:00",
                generation_id: "gen-1",
                model: "google/gemini-3.1-flash-image-preview-20260226",
                request_count: "1",
                total_usage: 0.06859,
                tokens_total: "1631",
                avg_latency: 10209,
              },
              {
                created_at__hour: "2026-09-02 16:00:00",
                generation_id: "gen-0",
                model: "google/gemini-3.1-flash-image-preview-20260226",
                request_count: "1",
                total_usage: 0.02,
                tokens_total: "900",
                avg_latency: 8000,
              },
            ],
          },
        }),
      );
    }
    if (u.includes("/generation?id=gen-1")) {
      return new Response(
        JSON.stringify({
          data: {
            id: "gen-1",
            created_at: "2026-09-02T16:43:15.364Z",
            model: "google/gemini-3.1-flash-image-preview-20260226",
            total_cost: 0.0685905,
            provider_name: "Google AI Studio",
            latency: 10209,
            tokens_prompt: 62,
            native_tokens_completion: 1574,
            num_media_completion: 1,
          },
        }),
      );
    }
    if (u.includes("/generation?id=")) return new Response("nf", { status: 404 });
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
  return { f, auth };
}

describe("walletActivity", () => {
  test("a statement: OpenRouter's generations and times, Stripe's payments, our refusals, balance after each", async () => {
    const store = fresh();
    store.recordEvent({
      sessionKey: DM,
      kind: "refused-exhausted",
      generation: "image",
      model: "google/gemini-3.1-flash-image-preview",
      remainingUsd: 0,
      atMs: Date.parse("2026-09-02T15:30:00Z"),
    });
    const { f, auth } = fakeOpenRouter();
    const a = await walletActivity({
      managementKey: "mgmt-key",
      store,
      wallet: store.get(DM)!,
      payments: [payment()],
      remainingNowUsd: 4.4114095,
      operatorAdjustUsd: 0,
      nowMs: NOW,
      sinceMs: NOW - DAY,
      fetch: f,
    });

    expect(a.rows.map((r) => r.kind)).toEqual([
      "generation",
      "generation",
      "payment",
      "refused-exhausted",
    ]);

    // Newest generation: exact moment and OpenRouter's final figure.
    const g1 = a.rows[0]!;
    expect(g1.generationId).toBe("gen-1");
    expect(g1.atExact).toBe(true);
    expect(g1.atMs).toBe(Date.parse("2026-09-02T16:43:15.364Z"));
    expect(g1.costUsd).toBe(0.0685905);
    expect(g1.provider).toBe("Google AI Studio");
    expect(g1.tokens).toBe(62 + 1574);
    expect(g1.media).toBe("image");
    expect(g1.balanceAfterUsd).toBeCloseTo(4.4114095, 6);

    // Older one: only the hour bucket and the analytics cost.
    const g0 = a.rows[1]!;
    expect(g0.generationId).toBe("gen-0");
    expect(g0.atExact).toBe(false);
    expect(g0.atMs).toBe(Date.parse("2026-09-02T16:00:00Z"));
    expect(g0.costUsd).toBe(0.02);
    expect(g0.balanceAfterUsd).toBeCloseTo(4.48, 6);

    const pay = a.rows[2]!;
    expect(pay.creditUsd).toBe(4.5);
    expect(pay.reference).toBe("pi_1");
    expect(pay.detail).toBe("Paid $5.30 by card");
    expect(pay.balanceAfterUsd).toBeCloseTo(4.5, 6);

    const refused = a.rows[3]!;
    expect(refused.model).toBe("google/gemini-3.1-flash-image-preview");
    expect(refused.media).toBe("image");
    expect(refused.costUsd).toBeNull();
    expect(refused.balanceAfterUsd).toBeCloseTo(0, 6);

    expect(a.generations).toBe(2);
    expect(a.spentUsd).toBeCloseTo(0.08859, 5);
    expect(a.complete).toBe(true);

    // The history is asked with the management key; each generation's
    // record with the person's own key.
    expect(auth.filter(([u]) => u.endsWith("/analytics/query")).map(([, h]) => h)).toEqual([
      "Bearer mgmt-key",
    ]);
    expect(auth.filter(([u]) => u.endsWith("/generation")).map(([, h]) => h)).toEqual([
      "Bearer sk-or-v1-user",
      "Bearer sk-or-v1-user",
    ]);
    store.close();
  });

  test("credit the operator added by hand opens the statement, dated at the key", async () => {
    const store = fresh();
    const f = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/analytics/query")) {
        return new Response(JSON.stringify({ data: { data: [] } }));
      }
      throw new Error(`unexpected ${String(url)}`);
    }) as typeof fetch;
    const wallet = store.get(DM)!;
    const a = await walletActivity({
      managementKey: "k",
      store,
      wallet,
      payments: [],
      remainingNowUsd: 2,
      operatorAdjustUsd: 2,
      nowMs: NOW,
      fetch: f,
    });
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.kind).toBe("operator-credit");
    expect(a.rows[0]!.creditUsd).toBe(2);
    expect(a.rows[0]!.atMs).toBe(wallet.createdAtMs);
    expect(a.rows[0]!.atExact).toBe(false);
    expect(a.rows[0]!.balanceAfterUsd).toBe(2);
    store.close();
  });

  test("a window OpenRouter cannot answer leaves the rest standing and says so", async () => {
    const store = fresh();
    const f = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/analytics/query")) return new Response("boom", { status: 500 });
      throw new Error(`unexpected ${String(url)}`);
    }) as typeof fetch;
    // The store stamps the key with the real clock; pin it before NOW so there
    // is a window to read at all, or the test only passes on the day it was written.
    const wallet = { ...store.get(DM)!, createdAtMs: NOW - DAY };
    const a = await walletActivity({
      managementKey: "k",
      store,
      wallet,
      payments: [payment()],
      remainingNowUsd: 4.5,
      operatorAdjustUsd: 0,
      nowMs: NOW,
      fetch: f,
    });
    expect(a.complete).toBe(false);
    expect(a.rows.map((r) => r.kind)).toEqual(["payment"]);
    expect(a.rows[0]!.balanceAfterUsd).toBe(4.5);
    store.close();
  });

  test("history goes back to the key, in 30-day windows, not forever", async () => {
    const store = fresh();
    const ranges: Array<{ start: string; end: string }> = [];
    const f = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { time_range: { start: string; end: string } };
      ranges.push(body.time_range);
      return new Response(JSON.stringify({ data: { data: [] } }));
    }) as typeof fetch;
    const wallet = { ...store.get(DM)!, createdAtMs: NOW - 50 * DAY };
    await walletActivity({
      managementKey: "k",
      store,
      wallet,
      payments: [],
      remainingNowUsd: 0,
      operatorAdjustUsd: 0,
      nowMs: NOW,
      fetch: f,
    });
    expect(ranges).toHaveLength(2);
    expect(Date.parse(ranges[1]!.start)).toBe(NOW - 50 * DAY - 3_600_000);
    store.close();
  });

  test("what a model makes is read off its slug", () => {
    expect(mediaKindOf("google/gemini-3.1-flash-image-preview-20260226")).toBe("image");
    expect(mediaKindOf("black-forest-labs/flux.2-pro")).toBe("image");
    expect(mediaKindOf("google/veo-3.1")).toBe("video");
    expect(mediaKindOf("openai/gpt-audio")).toBe("audio");
    expect(mediaKindOf("openai/whisper-large-v3")).toBe("audio");
    expect(mediaKindOf("anthropic/claude-sonnet-4.5")).toBe("other");
    expect(mediaKindOf("some/model", 1)).toBe("image");
  });
});
