import { describe, expect, test } from "bun:test";
import {
  computeSignature,
  publicUrlFor,
  signatureBase,
  validateTwilioSignature,
} from "../src/sms/signature.ts";

// Twilio's own published example, from the request-validation docs. Using a
// fixed vector rather than round-tripping our own implementation is the point:
// a round-trip test passes even if the whole scheme is wrong.
const TOKEN = "12345";
const URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const PARAMS = {
  CallSid: "CA1234567890ABCDE",
  Caller: "+12349013030",
  Digits: "1234",
  From: "+12349013030",
  To: "+18005551212",
};
const EXPECTED = "0/KCTR6DLpKmkAf8muzZqo1nDgQ=";

describe("twilio signature", () => {
  test("matches Twilio's published test vector", () => {
    expect(computeSignature(TOKEN, URL, PARAMS)).toBe(EXPECTED);
  });

  test("base string is url + params sorted by key, concatenated bare", () => {
    expect(signatureBase("https://x/y", { b: "2", a: "1" })).toBe("https://x/ya1b2");
  });

  test("accepts a valid signature", () => {
    expect(
      validateTwilioSignature({ authToken: TOKEN, url: URL, params: PARAMS, signature: EXPECTED }),
    ).toBe(true);
  });
});

describe("twilio signature rejects", () => {
  const bad = (over: Record<string, unknown>) =>
    validateTwilioSignature({
      authToken: TOKEN,
      url: URL,
      params: PARAMS,
      signature: EXPECTED,
      ...over,
    } as Parameters<typeof validateTwilioSignature>[0]);

  test("a tampered parameter", () => {
    expect(bad({ params: { ...PARAMS, From: "+15550000000" } })).toBe(false);
  });

  test("an added parameter", () => {
    expect(bad({ params: { ...PARAMS, Body: "injected" } })).toBe(false);
  });

  test("a different URL", () => {
    expect(bad({ url: "https://evil.com/myapp.php?foo=1&bar=2" })).toBe(false);
  });

  test("the wrong auth token", () => {
    expect(bad({ authToken: "54321" })).toBe(false);
  });

  test("a missing signature header", () => {
    expect(bad({ signature: null })).toBe(false);
    expect(bad({ signature: undefined })).toBe(false);
    expect(bad({ signature: "" })).toBe(false);
  });

  test("garbage in the signature header", () => {
    expect(bad({ signature: "not-base64!!" })).toBe(false);
    expect(bad({ signature: "AAAA" })).toBe(false);
  });

  test("an EMPTY auth token — must fail closed, never authenticate everything", () => {
    expect(bad({ authToken: "" })).toBe(false);
    // and specifically: an attacker who supplies the signature that an empty
    // token would produce still gets nothing.
    const forged = computeSignature("", URL, PARAMS);
    expect(
      validateTwilioSignature({ authToken: "", url: URL, params: PARAMS, signature: forged }),
    ).toBe(false);
  });
});

describe("publicUrlFor", () => {
  test("rebuilds the URL Twilio dialed, not the loopback one", () => {
    expect(publicUrlFor("https://sms.example.com", "/sms/inbound")).toBe(
      "https://sms.example.com/sms/inbound",
    );
  });

  test("tolerates trailing slash on the base and missing slash on the path", () => {
    expect(publicUrlFor("https://x.com/", "sms/inbound")).toBe("https://x.com/sms/inbound");
  });

  test("preserves the query string, which is part of the signed material", () => {
    expect(publicUrlFor("https://x.com", "/in", "a=1&b=2")).toBe("https://x.com/in?a=1&b=2");
    expect(publicUrlFor("https://x.com", "/in", "?a=1")).toBe("https://x.com/in?a=1");
  });
});
