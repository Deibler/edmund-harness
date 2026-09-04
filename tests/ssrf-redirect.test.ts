/**
 * The SSRF guard used to check the URL the model asked for and then follow
 * redirects blind. guardedFetch checks every hop. fetch is mocked so no
 * socket is opened.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { guardedFetch } from "../src/web/fetch.ts";
import { SsrfBlockedError } from "../src/web/ssrf.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit };
function mockFetch(script: Array<(call: Call) => Response>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const step = script[Math.min(i, script.length - 1)]!;
    i++;
    return step(call);
  }) as typeof fetch;
  return calls;
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const ok = () => new Response("fine", { status: 200 });

describe("guardedFetch", () => {
  test("a redirect to a private address is refused after the first hop passed", async () => {
    const calls = mockFetch([() => redirect("http://127.0.0.1:4747/api/config"), ok]);
    await expect(guardedFetch("https://example.com/page")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(calls.length).toBe(1);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  test("public redirects are followed and the final response returned", async () => {
    const calls = mockFetch([() => redirect("https://example.org/final"), ok]);
    const res = await guardedFetch("https://example.com/start");
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.com/start",
      "https://example.org/final",
    ]);
  });

  test("credential headers do not cross an origin change", async () => {
    const calls = mockFetch([() => redirect("https://other.example/x"), ok]);
    await guardedFetch("https://example.com/a", {
      headers: { Authorization: "Bearer t", "User-Agent": "ua", Cookie: "c=1" },
    });
    const second = calls[1]!.init.headers as Record<string, string>;
    expect(second.Authorization).toBeUndefined();
    expect(second.Cookie).toBeUndefined();
    expect(second["User-Agent"]).toBe("ua");
  });

  test("redirect loops stop", async () => {
    mockFetch([() => redirect("https://example.com/again")]);
    await expect(guardedFetch("https://example.com/again")).rejects.toThrow(/Too many redirects/);
  });

  test("non-http schemes are refused before any request", async () => {
    const calls = mockFetch([ok]);
    await expect(guardedFetch("file:///etc/passwd")).rejects.toThrow(/Unsupported URL scheme/);
    expect(calls.length).toBe(0);
  });
});
