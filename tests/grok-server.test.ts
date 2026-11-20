import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GrokAuthMode } from "../src/grok/auth.ts";
import {
  ASK_TOOL_DESCRIPTION,
  CHECK_TOOL_DESCRIPTION,
  REPORT_TOOL_DESCRIPTION,
  type ReportOutcome,
  TELL_TOOL_DESCRIPTION,
} from "../src/grok/mcp.ts";
import { startGrokServer } from "../src/grok/server.ts";

const TOKEN = "k".repeat(48);

type Running = {
  stop: () => void;
  port: number;
  asked: string[];
  told: string[];
  reports: Array<{ replyId: string; result: string }>;
};

function start(
  over: {
    authMode?: GrokAuthMode;
    asksPerMinute?: number;
    maxAuthFailures?: number;
    askDelayMs?: number;
  } = {},
): Running {
  const asked: string[] = [];
  const told: string[] = [];
  const reports: Array<{ replyId: string; result: string }> = [];
  const server = startGrokServer({
    port: 0,
    token: TOKEN,
    authMode: over.authMode ?? "both",
    maxMessageChars: 100,
    requestsPerMinute: 1_000,
    asksPerMinute: over.asksPerMinute ?? 50,
    maxAuthFailures: over.maxAuthFailures ?? 50,
    progressIntervalMs: 25,
    ask: async (message) => {
      asked.push(message);
      if (over.askDelayMs) await new Promise((r) => setTimeout(r, over.askDelayMs));
      return message.includes("2+2") ? "Four." : "ok";
    },
    tell: (message) => {
      told.push(message);
    },
    check: async () =>
      "Edmund is not working on anything right now. He has no new answers waiting.",
    report: (replyId, result): ReportOutcome => {
      reports.push({ replyId, result });
      return replyId === "gb-good"
        ? { ok: true }
        : { ok: false, error: "Edmund has no task with that reply_id." };
    },
  });
  return { ...server, asked, told, reports };
}

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  );
  return client;
}

describe("grok MCP server", () => {
  let s: Running;
  beforeAll(() => {
    s = start();
  });
  afterAll(() => s.stop());
  const base = () => `http://127.0.0.1:${s.port}/mcp`;

  test("lists the four tools, each with the description that routes Grok's voice to it", async () => {
    const client = await connect(base(), { Authorization: `Bearer ${TOKEN}` });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "ask_edmund",
      "tell_edmund",
      "check_edmund",
      "report_to_edmund",
    ]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.ask_edmund!.description).toBe(ASK_TOOL_DESCRIPTION);
    expect(by.tell_edmund!.description).toBe(TELL_TOOL_DESCRIPTION);
    expect(by.check_edmund!.description).toBe(CHECK_TOOL_DESCRIPTION);
    expect(by.report_to_edmund!.description).toBe(REPORT_TOOL_DESCRIPTION);

    // "ask Edmund" -> ask; "tell / have Edmund" -> tell; "did Edmund finish" -> check.
    expect(by.ask_edmund!.description).toContain('"ask Edmund');
    // The triggers are exclusive; the steer to the siblings comes after them.
    expect(by.ask_edmund!.description.split("For ")[0]).not.toContain("tell Edmund");
    expect(by.ask_edmund!.description.split("For ")[0]).not.toContain("have Edmund");
    expect(by.tell_edmund!.description).toContain('"tell Edmund');
    expect(by.tell_edmund!.description).toContain('"have Edmund');
    expect(by.tell_edmund!.description).toContain("texts it");
    expect(by.check_edmund!.description).toContain('"did Edmund finish"');
    expect(by.check_edmund!.description).toContain('"any word from Edmund"');
    expect(by.report_to_edmund!.description).toContain("reply_id");
    expect(by.report_to_edmund!.description).toContain("FOR GROK BOTS");

    // Each steers the near-miss phrasing to its sibling.
    expect(by.ask_edmund!.description).toContain("tell_edmund");
    expect(by.ask_edmund!.description).toContain("check_edmund");
    expect(by.tell_edmund!.description).toContain("ask_edmund");
    expect(by.tell_edmund!.description).toContain("check_edmund");

    expect(JSON.stringify(by.ask_edmund!.inputSchema)).toContain("maxLength");
    expect(JSON.stringify(by.tell_edmund!.inputSchema)).toContain("maxLength");
    expect(Object.keys(by.check_edmund!.inputSchema.properties ?? {})).toEqual([]);
    expect(by.report_to_edmund!.inputSchema.required).toEqual(["reply_id", "result"]);
    await client.close();
  });

  test("tell_edmund returns at once with the fixed acknowledgement and hands the message on", async () => {
    const client = await connect(base(), { Authorization: `Bearer ${TOKEN}` });
    const started = Date.now();
    const res = await client.callTool({
      name: "tell_edmund",
      arguments: { message: "connector test, no reply needed, reply KEEP_QUIET" },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.content).toEqual([{ type: "text", text: "Got it, Edmund's on it." }]);
    expect(s.told).toContain("connector test, no reply needed, reply KEEP_QUIET");
    await client.close();
  });

  test("check_edmund takes no arguments and returns the status text", async () => {
    const client = await connect(base(), { Authorization: `Bearer ${TOKEN}` });
    const res = await client.callTool({ name: "check_edmund", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([
      {
        type: "text",
        text: "Edmund is not working on anything right now. He has no new answers waiting.",
      },
    ]);
    await client.close();
  });

  test("report_to_edmund: a known id is thanked, an unknown id is an error", async () => {
    const client = await connect(base(), { Authorization: `Bearer ${TOKEN}` });
    const ok = await client.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: "gb-good", result: "three options" },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: "text", text: "Thanks, delivered." }]);
    const bad = await client.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: "gb-bogus", result: "x" },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0]!.text).toContain(
      "no task with that reply_id",
    );
    expect(s.reports).toEqual([
      { replyId: "gb-good", result: "three options" },
      { replyId: "gb-bogus", result: "x" },
    ]);
    await client.close();
  });

  test("report_to_edmund needs both fields", async () => {
    const client = await connect(base(), { Authorization: `Bearer ${TOKEN}` });
    const res = await client
      .callTool({ name: "report_to_edmund", arguments: { reply_id: "gb-good" } })
      .catch((e) => e);
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    await client.close();
  });

  test("calls ask_edmund with a bearer token", async () => {
    const client = await connect(base(), { Authorization: `Bearer ${TOKEN}` });
    const res = await client.callTool({ name: "ask_edmund", arguments: { message: "what's 2+2" } });
    expect(res.content).toEqual([{ type: "text", text: "Four." }]);
    await client.close();
  });

  test("calls ask_edmund with the token in ?key= and no header", async () => {
    const client = await connect(`${base()}?key=${TOKEN}`);
    const res = await client.callTool({ name: "ask_edmund", arguments: { message: "what's 2+2" } });
    expect(res.content).toEqual([{ type: "text", text: "Four." }]);
    await client.close();
  });

  test("rejects a bad token, a missing token, and a near-miss", async () => {
    for (const [url, headers] of [
      [base(), { Authorization: "Bearer nope" }],
      [base(), undefined],
      [`${base()}?key=${TOKEN}x`, undefined],
      [base(), { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ] as const) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    }
    await expect(connect(base(), { Authorization: "Bearer nope" })).rejects.toThrow();
  });

  test("rejects anything but POST, unknown paths, and bad bodies", async () => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await fetch(base(), { headers: auth })).status).toBe(405);
    expect((await fetch(base(), { method: "DELETE", headers: auth })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${s.port}/other`, { headers: auth })).status).toBe(404);
    const bad = await fetch(base(), { method: "POST", headers: auth, body: "not json" });
    expect(bad.status).toBe(400);
    const huge = await fetch(base(), { method: "POST", headers: auth, body: "x".repeat(40_000) });
    expect(huge.status).toBe(413);
  });

  test("caps the length of message", async () => {
    const client = await connect(base(), { Authorization: `Bearer ${TOKEN}` });
    const res = await client
      .callTool({ name: "ask_edmund", arguments: { message: "x".repeat(101) } })
      .catch((e) => e);
    // The SDK reports a schema violation either as an error result or a protocol error.
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    expect(s.asked.some((m) => m.length > 100)).toBe(false);
    await client.close();
  });

  test("answers the health check only from the local side", async () => {
    expect(await (await fetch(`http://127.0.0.1:${s.port}/grok/health`)).text()).toBe("ok");
    const viaTunnel = await fetch(`http://127.0.0.1:${s.port}/grok/health`, {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    expect(viaTunnel.status).toBe(404);
  });
});

describe("grok auth mode and limits", () => {
  test("'bearer' mode refuses the query parameter", async () => {
    const s = start({ authMode: "bearer" });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/mcp?key=${TOKEN}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    } finally {
      s.stop();
    }
  });

  test("'query' mode refuses the bearer header", async () => {
    const s = start({ authMode: "query" });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    } finally {
      s.stop();
    }
  });

  test("a source that keeps failing is shut out, even with the right token afterwards", async () => {
    const s = start({ maxAuthFailures: 3 });
    try {
      const url = `http://127.0.0.1:${s.port}/mcp`;
      const call = (auth: string) =>
        fetch(url, {
          method: "POST",
          headers: { Authorization: auth },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
      for (let i = 0; i < 3; i++) expect((await call("Bearer wrong")).status).toBe(401);
      expect((await call("Bearer wrong")).status).toBe(429);
      expect((await call(`Bearer ${TOKEN}`)).status).toBe(429);
    } finally {
      s.stop();
    }
  });

  test("turns are rate limited separately from listings", async () => {
    const s = start({ asksPerMinute: 2 });
    try {
      const client = await connect(`http://127.0.0.1:${s.port}/mcp`, {
        Authorization: `Bearer ${TOKEN}`,
      });
      const ask = () => client.callTool({ name: "ask_edmund", arguments: { message: "hi" } });
      expect((await ask()).isError).toBeFalsy();
      expect((await ask()).isError).toBeFalsy();
      const third = await ask();
      expect(third.isError).toBe(true);
      expect(s.asked).toHaveLength(2);
      await client.listTools(); // listing is not a turn
      await client.close();
    } finally {
      s.stop();
    }
  });
});

describe("progress while ask_edmund waits", () => {
  test("a call with a progress token gets progress notifications and then the answer", async () => {
    const s = start({ askDelayMs: 160 });
    try {
      const client = await connect(`http://127.0.0.1:${s.port}/mcp`, {
        Authorization: `Bearer ${TOKEN}`,
      });
      const seen: number[] = [];
      const res = await client.callTool(
        { name: "ask_edmund", arguments: { message: "what's 2+2" } },
        undefined,
        { onprogress: (p) => seen.push(p.progress) },
      );
      expect(res.content).toEqual([{ type: "text", text: "Four." }]);
      expect(seen.length).toBeGreaterThanOrEqual(3);
      // Strictly increasing, as the spec requires.
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
      expect(new Set(seen).size).toBe(seen.length);
      await client.close();
    } finally {
      s.stop();
    }
  });

  test("a call without a token is plain JSON and sends no progress", async () => {
    const s = start({ askDelayMs: 100 });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ask_edmund", arguments: { message: "what's 2+2" } },
        }),
      });
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
      expect(body.result.content[0]!.text).toBe("Four.");
    } finally {
      s.stop();
    }
  });

  test("a call with a token is answered on an event stream that ends with the result", async () => {
    const s = start({ askDelayMs: 100 });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "ask_edmund",
            arguments: { message: "what's 2+2" },
            _meta: { progressToken: "tok-1" },
          },
        }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const body = await res.text();
      expect(body).toContain("notifications/progress");
      expect(body).toContain('"progressToken":"tok-1"');
      expect(body).toContain("Four.");
      // The result is the last event.
      expect(body.lastIndexOf("Four.")).toBeGreaterThan(body.lastIndexOf("notifications/progress"));
    } finally {
      s.stop();
    }
  });

  test("the answer timeout fallback still applies with progress on", async () => {
    // The relay owns the timeout; here it answers "working on it" after 80 ms
    // while progress keeps flowing, and the call still ends with that line.
    const server = startGrokServer({
      port: 0,
      token: TOKEN,
      authMode: "both",
      maxMessageChars: 100,
      requestsPerMinute: 1_000,
      asksPerMinute: 50,
      maxAuthFailures: 50,
      progressIntervalMs: 20,
      ask: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return "Edmund's working on it, he'll text you the answer.";
      },
      tell: () => {},
      check: async () => "",
      report: () => ({ ok: true }),
    });
    try {
      const client = await connect(`http://127.0.0.1:${server.port}/mcp`, {
        Authorization: `Bearer ${TOKEN}`,
      });
      const res = await client.callTool(
        { name: "ask_edmund", arguments: { message: "something long" } },
        undefined,
        { onprogress: () => {} },
      );
      expect(res.content).toEqual([
        { type: "text", text: "Edmund's working on it, he'll text you the answer." },
      ]);
      await client.close();
    } finally {
      server.stop();
    }
  });
});
