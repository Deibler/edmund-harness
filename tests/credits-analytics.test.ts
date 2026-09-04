import { describe, expect, test } from "bun:test";
import {
  WINDOW_MS,
  generationDetail,
  keyGenerations,
  parseOpenRouterTime,
  windowsFor,
} from "../src/credits/analytics.ts";

const HASH = "6b9294c1".padEnd(64, "0");
const DAY = 86_400_000;

describe("OpenRouter analytics", () => {
  test("times come back as UTC without a zone marker", () => {
    expect(parseOpenRouterTime("2026-09-02 16:00:00")).toBe(Date.parse("2026-09-02T16:00:00Z"));
    expect(parseOpenRouterTime("2026-09-02T16:43:15.364Z")).toBe(
      Date.parse("2026-09-02T16:43:15.364Z"),
    );
    expect(parseOpenRouterTime(undefined)).toBeNull();
    expect(parseOpenRouterTime("nope")).toBeNull();
  });

  test("a long range is cut into 30-day windows, newest first, capped", () => {
    const until = Date.parse("2026-09-02T18:00:00Z");
    const w = windowsFor(until - 70 * DAY, until, 6);
    expect(w).toHaveLength(3);
    expect(w[0]).toEqual([until - WINDOW_MS, until]);
    expect(w[1]).toEqual([until - 2 * WINDOW_MS, until - WINDOW_MS]);
    expect(w[2]).toEqual([until - 70 * DAY, until - 2 * WINDOW_MS]);
    expect(windowsFor(until - 400 * DAY, until, 2)).toHaveLength(2);
    expect(windowsFor(until + 1, until, 6)).toHaveLength(0);
  });

  test("generations are asked per key, per generation id, at hour granularity; strings become numbers", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/analytics/query");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer mgmt-key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const range = body.time_range as { start: string; end: string };
      // The newest window has one generation; the older one repeats it (a
      // row on the boundary) plus another.
      const rows =
        bodies.length === 1
          ? [
              {
                created_at__hour: "2026-09-02 16:00:00",
                generation_id: "gen-1",
                model: "google/gemini-3.1-flash-image-preview-20260226",
                request_count: "1",
                total_usage: 0.06859,
                tokens_total: "1631",
                avg_latency: 10209,
              },
            ]
          : [
              {
                created_at__hour: "2026-09-02 16:00:00",
                generation_id: "gen-1",
                model: "google/gemini-3.1-flash-image-preview-20260226",
                request_count: "1",
                total_usage: 0.06859,
              },
              {
                created_at__hour: "2026-08-10 09:00:00",
                generation_id: "gen-0",
                model: "google/veo-3.1",
                request_count: "1",
                total_usage: 3.2,
                tokens_total: null,
                avg_latency: null,
              },
            ];
      expect(range.start < range.end).toBe(true);
      return new Response(JSON.stringify({ data: { data: rows } }));
    }) as typeof fetch;

    const until = Date.parse("2026-09-02T18:00:00Z");
    const r = await keyGenerations({
      managementKey: "mgmt-key",
      keyHash: HASH,
      sinceMs: until - 40 * DAY,
      untilMs: until,
      fetch: f,
    });
    expect(bodies).toHaveLength(2);
    const b = bodies[0]!;
    expect(b.dimensions).toEqual(["generation_id", "model"]);
    expect(b.granularity).toBe("hour");
    expect(b.filters).toEqual([{ field: "api_key_id", operator: "eq", value: HASH }]);
    expect(b.metrics).toContain("total_usage");
    expect((b.time_range as { end: string }).end).toBe("2026-09-02T18:00:00Z");
    expect(r.windows).toBe(2);
    expect(r.failedWindows).toBe(0);
    expect(r.generations.map((g) => g.generationId)).toEqual(["gen-1", "gen-0"]);
    const g1 = r.generations[0]!;
    expect(g1.hourMs).toBe(Date.parse("2026-09-02T16:00:00Z"));
    expect(g1.costUsd).toBe(0.06859);
    expect(g1.tokens).toBe(1631);
    expect(g1.latencyMs).toBe(10209);
    expect(r.generations[1]!.tokens).toBeNull();
  });

  test("one failed window is counted, not fatal", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return n === 1
        ? new Response("boom", { status: 500 })
        : new Response(
            JSON.stringify({
              data: {
                data: [
                  {
                    created_at__hour: "2026-08-01 01:00:00",
                    generation_id: "g",
                    model: "m",
                    request_count: "1",
                    total_usage: 0.01,
                  },
                ],
              },
            }),
          );
    }) as typeof fetch;
    const until = Date.parse("2026-09-02T18:00:00Z");
    const r = await keyGenerations({
      managementKey: "k",
      keyHash: HASH,
      sinceMs: until - 45 * DAY,
      untilMs: until,
      fetch: f,
    });
    expect(r.windows).toBe(2);
    expect(r.failedWindows).toBe(1);
    expect(r.generations).toHaveLength(1);
  });

  test("a generation's record is read with the key that made it; 404 is null", async () => {
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-v1-user");
      const u = String(url);
      if (u.endsWith("id=missing")) return new Response("nf", { status: 404 });
      expect(u).toBe("https://openrouter.ai/api/v1/generation?id=gen-1");
      return new Response(
        JSON.stringify({
          data: {
            id: "gen-1",
            created_at: "2026-09-02T16:43:15.364Z",
            model: "google/gemini-3.1-flash-image-preview-20260226",
            total_cost: 0.0685905,
            usage: 0.0685905,
            provider_name: "Google AI Studio",
            latency: 10209,
            tokens_prompt: 62,
            tokens_completion: 0,
            native_tokens_completion: 1574,
            num_media_completion: 1,
            finish_reason: "stop",
          },
        }),
      );
    }) as typeof fetch;
    const d = await generationDetail({ apiKey: "sk-or-v1-user", id: "gen-1", fetch: f });
    expect(d).toEqual({
      id: "gen-1",
      createdAtMs: Date.parse("2026-09-02T16:43:15.364Z"),
      model: "google/gemini-3.1-flash-image-preview-20260226",
      costUsd: 0.0685905,
      provider: "Google AI Studio",
      latencyMs: 10209,
      tokensPrompt: 62,
      tokensCompletion: 1574,
      mediaOut: 1,
      finishReason: "stop",
    });
    expect(await generationDetail({ apiKey: "sk-or-v1-user", id: "missing", fetch: f })).toBeNull();
  });
});
