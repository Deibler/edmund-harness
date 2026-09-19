import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { imessageActionTools } from "../src/mcp/tools/imessage-actions.ts";
import { messageTools } from "../src/mcp/tools/message.ts";
import { typingTools } from "../src/mcp/tools/typing.ts";

/**
 * The MCP server is its own process, so the SMS deliverer that
 * channels/deliver.ts holds does not exist here. Before the fix,
 * `send_message` in an SMS session fell through to the iMessage send path and
 * the Twilio Conversation SID reached chat.db, which answered
 * `chat_not_found` — the model believed it had spoken and the room heard
 * nothing.
 *
 * These drive the real tool handlers. `chat_db` points at a path that does
 * not exist, so any fall-through into the iMessage path throws instead of
 * quietly passing: remove the SMS branch in message.ts and these go red.
 */

const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  paths: { chat_db: "/nonexistent/never/chat.db" },
  sms: { enabled: true, from: "+15550000001" },
});

let dataDir: string;
let sandboxPath: string;
const realFetch = globalThis.fetch;
let requests: { url: string; body: string }[] = [];

function ctxFor(sessionKey: string): ToolContext {
  return {
    config,
    sessionKey,
    chatGuids: [],
    sandboxPath,
    dataDir,
    guestTier: null,
    sessionTier: "operator",
    // Touching any of these means the handler took the iMessage path.
    get chatDb(): never {
      throw new Error("chat.db must not be touched on an SMS session");
    },
    contacts: undefined,
    cron: undefined,
    bgJobs: undefined,
  } as unknown as ToolContext;
}

/** Twilio takes form-encoded bodies; read the field rather than the string. */
function field(body: string, name: string): string {
  return new URLSearchParams(body).get(name) ?? "";
}

function tool(name: string, sessionKey: string) {
  const def = messageTools(ctxFor(sessionKey)).find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sms-mcp-"));
  sandboxPath = mkdtempSync(join(tmpdir(), "sms-sbx-"));
  requests = [];
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "testtoken";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    requests.push({ url, body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ sid: "SM123", status: "queued" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(sandboxPath, { recursive: true, force: true });
});

describe("send_message on an SMS session", () => {
  test("a group session posts into the Twilio Conversation, not chat.db", async () => {
    const res = await tool("send_message", "sms:group:CH00000000000000000000000000000000").handler({
      text: "on it, pulling OC waters now",
    });
    expect(res.isError).toBeFalsy();
    expect(requests.length).toBe(1);
    // Groups are addressable only through the Conversations API.
    expect(requests[0]!.url).toContain(
      "/Conversations/CH00000000000000000000000000000000/Messages",
    );
    expect(field(requests[0]!.body, "Body")).toBe("on it, pulling OC waters now");
  });

  test("a dm session goes out over the Messages API", async () => {
    const res = await tool("send_message", "sms:dm:+15551230001").handler({ text: "hello" });
    expect(res.isError).toBeFalsy();
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toContain("/Messages.json");
    expect(field(requests[0]!.body, "To")).toBe("+15551230001");
  });

  test("iMessage-only options are dropped rather than failing the send", async () => {
    const res = await tool("send_message", "sms:group:CH00000000000000000000000000000000").handler({
      text: "hi",
      effect: "confetti",
      subject: "heads up",
    });
    expect(res.isError).toBeFalsy();
    expect(requests.length).toBe(1);
    expect(String(res.content[0]!.text)).toContain("iMessage-only");
  });

  test("a send failure is reported, not swallowed", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "nope", code: 21211 }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const res = await tool("send_message", "sms:dm:+15551230001").handler({ text: "hello" });
    expect(res.isError).toBe(true);
    expect(String(res.content[0]!.text)).toStartWith("send error:");
  });
});

describe("the other this-chat actions on SMS", () => {
  test("react refuses in words instead of failing on a missing chat", async () => {
    const res = await tool("react", "sms:group:CH00000000000000000000000000000000").handler({
      reaction: "laugh",
    });
    expect(res.isError).toBe(true);
    expect(String(res.content[0]!.text)).toContain("no tapbacks");
    expect(requests.length).toBe(0);
  });

  test("send_attachment refuses, and says what to do instead", async () => {
    const res = await tool("send_attachment", "sms:dm:+15551230001").handler({
      file_path: "/tmp/whatever.pdf",
    });
    expect(res.isError).toBe(true);
    expect(String(res.content[0]!.text)).toContain("SMS");
    expect(requests.length).toBe(0);
  });

  test("send_location degrades to the maps link as text", async () => {
    const res = await tool("send_location", "sms:dm:+15551230001").handler({
      name: "Castaways",
      latitude: 38.3,
      longitude: -75.09,
    });
    expect(res.isError).toBeFalsy();
    expect(requests.length).toBe(1);
    expect(field(requests[0]!.body, "Body")).toContain("maps.apple.com");
  });
});

describe("iMessage-only surfaces on an SMS session", () => {
  test("edit/unsend/delete are not registered at all", () => {
    const names = imessageActionTools(ctxFor("sms:dm:+15551230001")).map((t) => t.name);
    expect(names).toEqual([]);
    // Same context shape on iMessage still gets them, so this is not vacuous.
    expect(imessageActionTools(ctxFor("dm:+15551230001")).length).toBeGreaterThan(0);
  });

  test("activate_typing is a no-op rather than an error", async () => {
    const def = typingTools(ctxFor("sms:group:CH00000000000000000000000000000000")).find(
      (t) => t.name === "activate_typing",
    );
    if (!def) throw new Error("no activate_typing");
    const res = await def.handler({});
    expect(res.isError).toBeFalsy();
    expect(String(res.content[0]!.text)).toContain("no typing indicator");
  });
});
