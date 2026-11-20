import { describe, expect, test } from "bun:test";
import { presentedToken, sourceOf, tokenMatches } from "../src/grok/auth.ts";
import { RateLimiter } from "../src/grok/rate-limit.ts";
import { forVoice } from "../src/grok/reply-text.ts";

const TOKEN = "t".repeat(40);

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("presentedToken", () => {
  test("reads a bearer header and a ?key= parameter in 'both' mode", () => {
    expect(presentedToken(req("http://x/mcp", { authorization: `Bearer ${TOKEN}` }), "both")).toBe(
      TOKEN,
    );
    expect(presentedToken(req(`http://x/mcp?key=${TOKEN}`), "both")).toBe(TOKEN);
  });

  test("'bearer' mode ignores the query parameter, 'query' mode ignores the header", () => {
    expect(presentedToken(req(`http://x/mcp?key=${TOKEN}`), "bearer")).toBeNull();
    expect(
      presentedToken(req("http://x/mcp", { authorization: `Bearer ${TOKEN}` }), "query"),
    ).toBeNull();
  });

  test("a non-bearer scheme is not a token", () => {
    expect(
      presentedToken(req("http://x/mcp", { authorization: `Basic ${TOKEN}` }), "both"),
    ).toBeNull();
    expect(presentedToken(req("http://x/mcp"), "both")).toBeNull();
  });
});

describe("tokenMatches", () => {
  test("accepts only the exact token", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});

describe("sourceOf", () => {
  test("prefers Cloudflare's connecting address, falls back to local", () => {
    expect(sourceOf(req("http://x/", { "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(sourceOf(req("http://x/"))).toBe("local");
  });
});

describe("RateLimiter", () => {
  test("refuses past the limit and forgives after the window", () => {
    let now = 1_000;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.blocked("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    now += 60_001;
    expect(limiter.blocked("a")).toBe(false);
    expect(limiter.take("a")).toBe(true);
  });
});

describe("forVoice", () => {
  test("flattens line breaks", () => {
    expect(forVoice("one.\n\ntwo.\nthree.", 100)).toBe("one. two. three.");
  });

  test("cuts at a sentence, not mid-word", () => {
    const text = "First sentence here. Second sentence goes on and on and on and on.";
    expect(forVoice(text, 40)).toBe("First sentence here.");
  });

  test("falls back to a word boundary when there is no sentence to cut at", () => {
    const out = forVoice("word ".repeat(40), 22);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(23);
  });
});
