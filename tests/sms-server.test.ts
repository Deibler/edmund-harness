import { afterAll, describe, expect, test } from "bun:test";
import { startSmsServer } from "../src/sms/server.ts";
import { computeSignature } from "../src/sms/signature.ts";

const TOKEN = "test-auth-token";
const BASE = "https://sms-test.example.com";
const PORT = 45911;

const seen: Record<string, string>[] = [];
const server = startSmsServer({
  port: PORT,
  authToken: TOKEN,
  publicBaseUrl: () => BASE,
  onConversationMessage: async (p) => {
    seen.push(p);
  },
});
afterAll(() => server.stop());

function post(path: string, params: Record<string, string>, signature?: string) {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (signature !== undefined) headers["X-Twilio-Signature"] = signature;
  return fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers, body });
}

describe("sms webhook server", () => {
  const params = { ConversationSid: "CHx", MessageSid: "IMx", Author: "+15551230001", Body: "hi" };

  test("a correctly signed request is accepted and handled", async () => {
    const sig = computeSignature(TOKEN, `${BASE}/sms/conversations`, params);
    const res = await post("/sms/conversations", params, sig);
    expect(res.status).toBe(204);
    expect(seen.length).toBe(1);
    expect(seen[0]!.Body).toBe("hi");
  });

  test("an unsigned request is 403 and never reaches the handler", async () => {
    const before = seen.length;
    const res = await post("/sms/conversations", params);
    expect(res.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  test("a request signed with the wrong token is 403", async () => {
    const before = seen.length;
    const sig = computeSignature("wrong-token", `${BASE}/sms/conversations`, params);
    const res = await post("/sms/conversations", params, sig);
    expect(res.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  test("a signature over tampered params is 403", async () => {
    const before = seen.length;
    const sig = computeSignature(TOKEN, `${BASE}/sms/conversations`, params);
    const res = await post("/sms/conversations", { ...params, Body: "injected" }, sig);
    expect(res.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  test("health endpoint answers on loopback without a signature", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/sms/health`);
    expect(res.status).toBe(200);
  });

  test("a throwing handler is contained — 204, no retry storm", async () => {
    const crash = { ...params, MessageSid: "IMcrash" };
    const sig = computeSignature(TOKEN, `${BASE}/sms/conversations`, crash);
    const original = seen.push.bind(seen);
    // simulate a handler crash for this one message
    (seen as unknown as { push: (p: Record<string, string>) => number }).push = (p) => {
      if (p.MessageSid === "IMcrash") throw new Error("boom");
      return original(p);
    };
    const res = await post("/sms/conversations", crash, sig);
    expect(res.status).toBe(204);
  });
});
