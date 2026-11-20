/**
 * Per-bot connector keys: the connector names the caller from the key it
 * presented, and that identity reaches the inbound, the envelope's From line,
 * the exchange log and the report check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  entryToInbound,
  parsePendingLine,
  pendingToInbound,
  toPendingEntry,
} from "../src/bridge/session-queue.ts";
import { buildEnvelope } from "../src/channels/envelope.ts";
import type { SessionPipeline } from "../src/channels/pipeline.ts";
import { type Config, ConfigSchema } from "../src/config/config.ts";

const GrokSchema = ConfigSchema.shape.grok;
import { type ConnectorBot, resolveCaller } from "../src/grok/auth.ts";
import {
  type GrokCaller,
  SHARED_CALLER,
  callerShort,
  callerTag,
  describeCaller,
  isGrokCaller,
} from "../src/grok/caller.ts";
import {
  connectorBotsOf,
  createGrokChannel,
  handleReport,
  reportMessage,
} from "../src/grok/channel.ts";
import { ExchangeLog, describeExchange } from "../src/grok/exchanges.ts";
import { PendingTasks } from "../src/grok/pending.ts";
import { startGrokServer } from "../src/grok/server.ts";
import { GROK_REPORT_SERVICE, GROK_SERVICE, GROK_TELL_SERVICE } from "../src/grok/session.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";

const HANDLE = "+15550100001";
const SHARED = "s".repeat(40);
const GROKBOT_KEY = "a1".repeat(32);
const GLEP_KEY = "b2".repeat(32);

const BOTS: ConnectorBot[] = [
  { name: "grokbot", token: GROKBOT_KEY, label: "Grok Bot" },
  {
    name: "glep",
    token: GLEP_KEY,
    label: "Glep",
    description: "a deliberately simple Grok bot",
  },
];

const GROKBOT: GrokCaller = { kind: "bot", bot: "grokbot", label: "Grok Bot" };
const GLEP: GrokCaller = {
  kind: "bot",
  bot: "glep",
  label: "Glep",
  description: "a deliberately simple Grok bot",
};

let dir: string;
const closers: Array<() => void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grok-caller-"));
});
afterEach(() => {
  for (const c of closers.splice(0)) c();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

describe("resolveCaller", () => {
  test("the shared key is the shared caller, as before", () => {
    expect(resolveCaller(SHARED, SHARED, BOTS)).toEqual({ kind: "shared" });
    expect(resolveCaller(SHARED, SHARED, [])).toEqual({ kind: "shared" });
  });

  test("each bot's own key is that bot, with its label and description", () => {
    expect(resolveCaller(GROKBOT_KEY, SHARED, BOTS)).toEqual(GROKBOT);
    expect(resolveCaller(GLEP_KEY, SHARED, BOTS)).toEqual(GLEP);
  });

  test("a bad, near-miss, empty or missing key is nobody", () => {
    expect(resolveCaller("nope", SHARED, BOTS)).toBeNull();
    expect(resolveCaller(`${GLEP_KEY}x`, SHARED, BOTS)).toBeNull();
    expect(resolveCaller(GLEP_KEY.slice(1), SHARED, BOTS)).toBeNull();
    expect(resolveCaller("", SHARED, BOTS)).toBeNull();
    expect(resolveCaller(null, SHARED, BOTS)).toBeNull();
  });

  test("a bot's webhook key or another bot's token does not stand in for its connector token", () => {
    expect(resolveCaller("xai-webhook-key", SHARED, BOTS)).toBeNull();
  });

  test("a bot entry with an empty token never matches an empty presentation", () => {
    expect(resolveCaller("", SHARED, [{ name: "x", token: "", label: "X" }])).toBeNull();
  });

  test("a bot token equal to the shared key resolves to the shared caller", () => {
    expect(resolveCaller(SHARED, SHARED, [{ name: "x", token: SHARED, label: "X" }])).toEqual({
      kind: "shared",
    });
  });
});

describe("connectorBotsOf", () => {
  const grok = (bots: Record<string, unknown>) => GrokSchema.parse({ token: SHARED, bots });
  const hook = "https://example.com/hook";

  test("takes the token, label (default: the name) and description", () => {
    const out = connectorBotsOf(
      grok({
        grokbot: { webhook_url: hook, key: "k", connector_token: GROKBOT_KEY, label: "Grok Bot" },
        glep: {
          webhook_url: hook,
          key: "k",
          connector_token: GLEP_KEY,
          description: " a simple bot ",
        },
        plain: { webhook_url: hook, key: "k" },
      }),
    );
    expect(out).toEqual([
      { name: "grokbot", token: GROKBOT_KEY, label: "Grok Bot" },
      { name: "glep", token: GLEP_KEY, label: "glep", description: "a simple bot" },
    ]);
  });

  test("a token that repeats the shared key or another bot's is dropped", () => {
    const out = connectorBotsOf(
      grok({
        a: { webhook_url: hook, key: "k", connector_token: GROKBOT_KEY },
        b: { webhook_url: hook, key: "k", connector_token: GROKBOT_KEY },
        c: { webhook_url: hook, key: "k", connector_token: SHARED },
      }),
    );
    expect(out.map((b) => b.name)).toEqual(["a"]);
  });
});

describe("[grok.bots.<name>] schema", () => {
  test("connector_token, label and description are optional; a short token is refused", () => {
    const hook = "https://example.com/hook";
    expect(() => GrokSchema.parse({ bots: { a: { webhook_url: hook, key: "k" } } })).not.toThrow();
    const ok = GrokSchema.parse({
      bots: {
        a: {
          webhook_url: hook,
          key: "k",
          connector_token: GLEP_KEY,
          label: "Glep",
          description: "x",
        },
      },
    });
    expect(ok.bots.a?.connector_token).toBe(GLEP_KEY);
    expect(ok.bots.a?.label).toBe("Glep");
    expect(() =>
      GrokSchema.parse({
        bots: { a: { webhook_url: hook, key: "k", connector_token: "short" } },
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The listener: 401 for a bad key, and every tool is told who called
// ---------------------------------------------------------------------------

type Call = { tool: string; caller: GrokCaller; args: unknown[] };

function listener() {
  const calls: Call[] = [];
  const server = startGrokServer({
    port: 0,
    token: SHARED,
    bots: BOTS,
    authMode: "both",
    maxMessageChars: 100,
    requestsPerMinute: 1_000,
    asksPerMinute: 100,
    maxAuthFailures: 100,
    ask: async (message, caller) => {
      calls.push({ tool: "ask", caller, args: [message] });
      return "ok";
    },
    tell: (message, caller) => {
      calls.push({ tool: "tell", caller, args: [message] });
    },
    check: async (caller) => {
      calls.push({ tool: "check", caller, args: [] });
      return "Edmund is not working on anything right now.";
    },
    report: (replyId, result, caller) => {
      calls.push({ tool: "report", caller, args: [replyId, result] });
      return { ok: true };
    },
  });
  closers.push(() => server.stop());
  return { calls, port: server.port };
}

async function connect(port: number, key: string): Promise<Client> {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/grok/mcp?key=${key}`)),
  );
  closers.push(() => void client.close());
  return client;
}

describe("the listener names the caller from the key", () => {
  test("a bad or missing key is a 401, a good one of any kind is not", async () => {
    const { port } = listener();
    const post = (url: string, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    const base = `http://127.0.0.1:${port}/grok/mcp`;
    expect((await post(`${base}?key=bogus`)).status).toBe(401);
    expect((await post(base)).status).toBe(401);
    expect((await post(base, { authorization: "Bearer bogus" })).status).toBe(401);
    expect((await post(`${base}?key=${SHARED}`)).status).toBe(200);
    expect((await post(`${base}?key=${GROKBOT_KEY}`)).status).toBe(200);
    expect((await post(base, { authorization: `Bearer ${GLEP_KEY}` })).status).toBe(200);
  });

  test("ask, tell, check and report each carry the caller the key proved", async () => {
    const { port, calls } = listener();
    const keys: Array<[string, GrokCaller]> = [
      [SHARED, SHARED_CALLER],
      [GROKBOT_KEY, GROKBOT],
      [GLEP_KEY, GLEP],
    ];
    for (const [key, caller] of keys) {
      const client = await connect(port, key);
      expect((await client.listTools()).tools).toHaveLength(4);
      await client.callTool({ name: "ask_edmund", arguments: { message: "a?" } });
      await client.callTool({ name: "tell_edmund", arguments: { message: "t" } });
      await client.callTool({ name: "check_edmund", arguments: {} });
      await client.callTool({
        name: "report_to_edmund",
        arguments: { reply_id: "gb-1", result: "r" },
      });
      const mine = calls.splice(0);
      expect(mine.map((c) => c.tool)).toEqual(["ask", "tell", "check", "report"]);
      for (const c of mine) expect(c.caller).toEqual(caller);
    }
  });
});

// ---------------------------------------------------------------------------
// Through the channel: the inbound, the exchange log, the envelope
// ---------------------------------------------------------------------------

function channelConfig(): Config {
  return {
    paths: { data_dir: dir },
    grok: {
      enabled: true,
      handle: HANDLE,
      port: 0,
      token: SHARED,
      auth_mode: "both",
      answer_timeout_ms: 25_000,
      slow_reply: "later",
      max_message_chars: 1000,
      max_reply_chars: 700,
      requests_per_minute: 600,
      asks_per_minute: 60,
      max_auth_failures: 10,
      bots: {
        grokbot: {
          webhook_url: "https://example.com/a",
          key: "wh-a",
          connector_token: GROKBOT_KEY,
          label: "Grok Bot",
        },
        glep: {
          webhook_url: "https://example.com/b",
          key: "wh-b",
          connector_token: GLEP_KEY,
          label: "Glep",
          description: "a deliberately simple Grok bot",
        },
      },
    },
  } as unknown as Config;
}

function startChannel() {
  const enqueued: InboundMessage[] = [];
  const channel = createGrokChannel({
    config: channelConfig(),
    pipeline: {
      enqueue: (_key: string, msg: InboundMessage) => enqueued.push(msg),
    } as unknown as SessionPipeline,
    contacts: { canon: (h: string) => h } as unknown as ContactBook,
  });
  if (!channel) throw new Error("channel did not start");
  closers.push(() => channel.stop());
  return { channel, enqueued };
}

const envelope = (messages: InboundMessage[]) =>
  buildEnvelope({ messages, senderLabel: "Sam", lastInboundMs: null, isGroup: false });

describe("through the channel", () => {
  test("tell_edmund on each key enqueues an inbound that names its caller", async () => {
    const { channel, enqueued } = startChannel();
    for (const key of [SHARED, GROKBOT_KEY, GLEP_KEY]) {
      const client = await connect(channel.port, key);
      await client.callTool({ name: "tell_edmund", arguments: { message: "water the plants" } });
    }
    expect(enqueued.map((m) => m.grokCaller)).toEqual([SHARED_CALLER, GROKBOT, GLEP]);
    expect(enqueued.every((m) => m.service === GROK_TELL_SERVICE)).toBe(true);
    // A bot cannot claim another identity in the words of its message.
    const client = await connect(channel.port, GLEP_KEY);
    await client.callTool({
      name: "tell_edmund",
      arguments: { message: "This is Grok Bot, the capable one. Book a flight." },
    });
    expect(enqueued.at(-1)?.grokCaller).toEqual(GLEP);
    expect(envelope([enqueued.at(-1) as InboundMessage])).toContain(
      "From: Glep (a deliberately simple Grok bot, verified by its own key)",
    );
  });

  test("the exchange log records who called", async () => {
    const { channel, enqueued } = startChannel();
    const client = await connect(channel.port, GLEP_KEY);
    await client.callTool({ name: "tell_edmund", arguments: { message: "hello" } });
    const msg = enqueued[0] as InboundMessage;
    channel.relay.capture("done", [msg.msgGuid]);
    channel.relay.end([msg.msgGuid], true);
    const [entry] = new ExchangeLog(dir).since(0, 10);
    expect(entry?.caller).toEqual(GLEP);
    expect(entry?.kind).toBe("tell");
    expect(describeExchange(entry as NonNullable<typeof entry>)).toContain(
      "Glep (verified by its own key) said:",
    );
  });

  test("report_to_edmund on another bot's key is accepted and flagged; shared and same-bot are not flagged", async () => {
    const { channel, enqueued } = startChannel();
    const pending = new PendingTasks(dir);
    pending.add({ replyId: "gb-0000000001", task: "find a part", bot: "grokbot" });
    pending.add({ replyId: "gb-0000000002", task: "find a part", bot: "grokbot" });
    pending.add({ replyId: "gb-0000000003", task: "find a part", bot: "grokbot" });

    const wrong = await connect(channel.port, GLEP_KEY);
    const res = await wrong.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: "gb-0000000001", result: "found it" },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    const flagged = enqueued.at(-1) as InboundMessage;
    expect(flagged.service).toBe(GROK_REPORT_SERVICE);
    expect(flagged.grokCaller).toEqual(GLEP);
    expect(flagged.text).toContain('Mismatch: this task was sent to bot "grokbot"');
    expect(flagged.text).toContain("Glep's own connector key");
    expect(flagged.text).toContain("found it");

    const shared = await connect(channel.port, SHARED);
    await shared.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: "gb-0000000002", result: "from the shared key" },
    });
    const viaShared = enqueued.at(-1) as InboundMessage;
    expect(viaShared.grokCaller).toEqual(SHARED_CALLER);
    expect(viaShared.text).not.toContain("Mismatch");
    expect(viaShared.text).toContain("from the shared key");

    const right = await connect(channel.port, GROKBOT_KEY);
    await right.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: "gb-0000000003", result: "from the right bot" },
    });
    const viaRight = enqueued.at(-1) as InboundMessage;
    expect(viaRight.grokCaller).toEqual(GROKBOT);
    expect(viaRight.text).not.toContain("Mismatch");
  });
});

describe("handleReport", () => {
  function rig() {
    const pending = new PendingTasks(dir);
    const woke: Array<{ text: string; said: string; caller?: GrokCaller }> = [];
    const relay = {
      report: (text: string, said: string, caller?: GrokCaller) =>
        woke.push({ text, said, caller }),
    };
    return { pending, woke, report: handleReport.bind(null, { pending, relay }) };
  }

  test("records which bot's key reported, and flags a mismatch in the audit line too", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-aaaaaaaaaa", task: "t", bot: "grokbot" });
    expect(r.report("gb-aaaaaaaaaa", "done", GLEP)).toEqual({ ok: true });
    const found = r.pending.lookup("gb-aaaaaaaaaa");
    expect(found.status === "reported" && found.task.reportedBy).toBe("glep");
    expect(r.woke).toHaveLength(1);
    expect(r.woke[0]?.said).toContain("reported on Glep's key");
    expect(r.woke[0]?.said).toContain('task was sent to "grokbot"');
    expect(r.woke[0]?.caller).toEqual(GLEP);
  });

  test("the shared key reports exactly as before", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-bbbbbbbbbb", task: "t", bot: "grokbot" });
    expect(r.report("gb-bbbbbbbbbb", "done")).toEqual({ ok: true });
    expect(r.woke[0]?.said).toBe("Grok Bot finished task gb-bbbbbbbbbb");
    expect(r.woke[0]?.text).not.toContain("Mismatch");
    const found = r.pending.lookup("gb-bbbbbbbbbb");
    expect(found.status === "reported" && found.task.reportedBy).toBeUndefined();
  });

  test("a wait_for_result call is handed a mismatched result and wakes no one", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-cccccccccc", task: "t", bot: "grokbot", waitMs: 60_000 });
    expect(r.report("gb-cccccccccc", "answer", GLEP).ok).toBe(true);
    expect(r.woke).toHaveLength(0);
    const found = r.pending.lookup("gb-cccccccccc");
    expect(found.status === "reported" && found.task.reportedBy).toBe("glep");
  });

  test("reportMessage without a reporter has no mismatch line", () => {
    expect(reportMessage("gb-1", "grokbot", "t", "r")).not.toContain("Mismatch");
    expect(reportMessage("gb-1", "grokbot", "t", "r", GROKBOT)).not.toContain("Mismatch");
    expect(reportMessage("gb-1", "grokbot", "t", "r", GLEP)).toContain("Mismatch");
  });
});

// ---------------------------------------------------------------------------
// The envelope's From line
// ---------------------------------------------------------------------------

function grokMsg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    rowId: -1,
    msgGuid: "grok-1",
    chatIdentifier: HANDLE,
    chatGuid: `any;-;${HANDLE}`,
    isGroup: false,
    fromHandle: HANDLE,
    fromMe: false,
    text: "what's the weather",
    timestampMs: 1_700_000_000_000,
    attachments: [],
    attachmentTranscripts: {},
    service: GROK_SERVICE,
    replyToGuid: null,
    ...over,
  };
}

describe("the From line names the caller from the key", () => {
  test("a bot with a description", () => {
    const out = envelope([grokMsg({ grokCaller: GLEP })]);
    expect(out).toContain(
      "From: Glep (a deliberately simple Grok bot, verified by its own key), calling for Sam",
    );
    expect(out).toContain("The From line names the caller from the key it presented");
  });

  test("a bot without one", () => {
    const out = envelope([grokMsg({ grokCaller: GROKBOT })]);
    expect(out).toContain("From: Grok Bot (verified by its own key), calling for Sam");
  });

  test("the shared key says it cannot tell the car from a bot without its own key", () => {
    const out = envelope([grokMsg({ grokCaller: SHARED_CALLER })]);
    expect(out).toContain(
      "From: Grok connector (shared key: the car's Grok or a bot that did not use its own key), calling for Sam",
    );
  });

  test("a request with no recorded caller keeps the plain wording", () => {
    const out = envelope([grokMsg()]);
    expect(out).toContain("From: Grok connector, calling for Sam\n");
    expect(out).not.toContain("verified by its own key");
    expect(out).not.toContain("The From line names the caller");
  });

  test("a report is attributed too", () => {
    const out = envelope([
      grokMsg({ service: GROK_REPORT_SERVICE, grokCaller: GROKBOT, text: "report text" }),
    ]);
    expect(out).toContain("From: Grok Bot (verified by its own key), calling for Sam");
    expect(out).toContain("Grok Bot callback");
  });

  test("two callers in one batch are both named, and each line says who spoke", () => {
    const out = envelope([
      grokMsg({ msgGuid: "g1", text: "from glep", grokCaller: GLEP }),
      grokMsg({ msgGuid: "g2", text: "from the car", grokCaller: SHARED_CALLER }),
    ]);
    expect(out).toContain("From: Glep (a deliberately simple Grok bot, verified");
    expect(out).toContain(" and Grok connector (shared key:");
    expect(out).toMatch(/\[Grok connector \(Glep\) · [^\]]+\] from glep/);
    expect(out).toMatch(/\[Grok connector \(shared key\) · [^\]]+\] from the car/);
  });

  test("two messages from one bot are one name", () => {
    const out = envelope([
      grokMsg({ msgGuid: "g1", grokCaller: GROKBOT }),
      grokMsg({ msgGuid: "g2", text: "again", grokCaller: GROKBOT }),
    ]);
    const from = out.split("\n").find((l) => l.startsWith("From:")) as string;
    expect(from).toBe("From: Grok Bot (verified by its own key), calling for Sam");
  });
});

describe("caller helpers", () => {
  test("names", () => {
    expect(callerShort(GLEP)).toBe("Glep");
    expect(callerShort(SHARED_CALLER)).toBe("shared key");
    expect(callerTag(GLEP)).toBe("Glep (verified by its own key)");
    expect(callerTag(SHARED_CALLER)).toBe("Grok (shared key)");
    expect(describeCaller(GROKBOT)).toBe("Grok Bot (verified by its own key)");
  });

  test("isGrokCaller accepts what JSON round-trips and nothing else", () => {
    expect(isGrokCaller(JSON.parse(JSON.stringify(GLEP)))).toBe(true);
    expect(isGrokCaller({ kind: "shared" })).toBe(true);
    expect(isGrokCaller({ kind: "bot", bot: "x" })).toBe(false);
    expect(isGrokCaller({ kind: "admin" })).toBe(false);
    expect(isGrokCaller(null)).toBe(false);
  });
});

describe("a parked request keeps its caller", () => {
  test("through the pending queue and the ack table", () => {
    const msg = grokMsg({ grokCaller: GLEP });
    const line = JSON.stringify(toPendingEntry(msg));
    const entry = parsePendingLine(line);
    expect(entry?.grokCaller).toEqual(GLEP);
    expect((entry && entryToInbound(entry))?.grokCaller).toEqual(GLEP);
    expect((entry && pendingToInbound(entry, msg))?.grokCaller).toEqual(GLEP);
  });

  test("an old line without a caller still parses, with none", () => {
    const entry = parsePendingLine(JSON.stringify(toPendingEntry(grokMsg())));
    expect(entry?.grokCaller).toBeUndefined();
    expect((entry && entryToInbound(entry))?.grokCaller).toBeUndefined();
  });

  test("garbage in the caller field is dropped, not trusted", () => {
    const raw = { ...toPendingEntry(grokMsg()), grokCaller: { kind: "bot", bot: 7 } };
    expect(parsePendingLine(JSON.stringify(raw))?.grokCaller).toBeUndefined();
  });
});
