import { afterEach, describe, expect, test } from "bun:test";
import {
  REPLY_INSTRUCTIONS,
  type WebhookPayload,
  postToBot,
  webhookPayload,
} from "../src/grok/webhook.ts";

const KEY = "xai-webhook-key-SECRET-0123456789";

type Seen = { method: string; auth: string | null; type: string | null; body: unknown };
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A stand-in for the Grok webhook trigger. */
function mockGrok(respond: (req: Request) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      seen.push({
        method: req.method,
        auth: req.headers.get("authorization"),
        type: req.headers.get("content-type"),
        body: await req.json().catch(() => null),
      });
      return respond(req);
    },
  });
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${server.port}/hooks/abc123` };
}

describe("webhookPayload", () => {
  test("is exactly the shape the Bot is told to expect", () => {
    expect(webhookPayload("find a cabin", "gb-0123456789")).toEqual({
      task: "find a cabin",
      reply_id: "gb-0123456789",
      from: "Edmund",
      reply_instructions:
        "When done, call the report_to_edmund tool on the Edmund connector with this reply_id and your result. If you can't, say why in the result.",
    });
    expect(REPLY_INSTRUCTIONS).toContain("report_to_edmund");
  });
});

describe("postToBot", () => {
  const payload: WebhookPayload = webhookPayload("find a cabin", "gb-0123456789");

  test("POSTs JSON with the bearer key and treats a 200 as accepted", async () => {
    const g = mockGrok(() => new Response("{}", { status: 200 }));
    const out = await postToBot({ webhook_url: g.url, key: KEY }, "main", payload);
    expect(out).toEqual({ ok: true });
    expect(g.seen).toHaveLength(1);
    expect(g.seen[0]!.method).toBe("POST");
    expect(g.seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(g.seen[0]!.type).toBe("application/json");
    expect(g.seen[0]!.body).toEqual(payload);
  });

  test("any 2xx is accepted", async () => {
    for (const status of [202, 204]) {
      const g = mockGrok(() => new Response(null, { status }));
      expect(await postToBot({ webhook_url: g.url, key: KEY }, "main", payload)).toEqual({
        ok: true,
      });
    }
  });

  test.each([
    [401, "rejected the key"],
    [403, "rejected the key"],
    [404, "no routine"],
    [410, "no routine"],
    [429, "rate limiting"],
    [500, "server error"],
    [503, "server error"],
    [418, "did not accept"],
  ])("HTTP %i is a clear error that names the bot and the fix", async (status, phrase) => {
    const g = mockGrok(() => new Response("some body with a secret in it", { status }));
    const out = await postToBot({ webhook_url: g.url, key: KEY }, "glep", payload);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain(phrase);
    expect(out.error).toContain('"glep"');
    expect(out.error).toContain(`HTTP ${status}`);
  });

  test("errors never carry the key, the URL, or the response body", async () => {
    const g = mockGrok(() => new Response(`echo ${KEY}`, { status: 401 }));
    const bad = await postToBot({ webhook_url: g.url, key: KEY }, "main", payload);
    const down = await postToBot(
      { webhook_url: "http://127.0.0.1:1/hooks/abc123", key: KEY },
      "main",
      payload,
    );
    for (const out of [bad, down]) {
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.error).not.toContain(KEY);
      expect(out.error).not.toContain("hooks/abc123");
      expect(out.error).not.toContain("127.0.0.1");
      expect(out.error).not.toContain("echo");
    }
  });

  test("an unreachable host is an error, not a throw", async () => {
    const out = await postToBot({ webhook_url: "http://127.0.0.1:1/x", key: KEY }, "main", payload);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("Could not reach Grok");
  });

  test("a slow webhook times out with a message that says the task may have started", async () => {
    const g = mockGrok(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return new Response("{}");
    });
    const out = await postToBot({ webhook_url: g.url, key: KEY }, "main", payload, {
      timeoutMs: 60,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("may or may not have started");
  });

  test("a redirect is not followed (the key must not travel to another host)", async () => {
    const other = mockGrok(() => new Response("{}"));
    const g = mockGrok(() => Response.redirect(other.url, 302));
    const out = await postToBot({ webhook_url: g.url, key: KEY }, "main", payload);
    expect(out.ok).toBe(false);
    expect(other.seen).toHaveLength(0);
  });
});
