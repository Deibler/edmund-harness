import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SessionPipeline } from "../src/channels/pipeline.ts";
import { type Config, ConfigSchema } from "../src/config/config.ts";
import { createGrokChannel, handleReport, reportMessage } from "../src/grok/channel.ts";
import { ExchangeLog } from "../src/grok/exchanges.ts";
import { PENDING_TTL_MS, type PendingOrigin, PendingTasks } from "../src/grok/pending.ts";
import { GROK_REPORT_SERVICE, GROK_TELL_SERVICE } from "../src/grok/session.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { grokBotTools } from "../src/mcp/tools/grokbot.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { dmKeyFor, sessionKeyFor } from "../src/sessions/key.ts";

const HANDLE = "+15550100001";
const TOKEN = "r".repeat(40);
const BOT_KEY = "xai-bot-key-round-trip-secret";

let dir: string;
const closers: Array<() => void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grok-report-"));
});
afterEach(() => {
  for (const c of closers.splice(0)) c();
  rmSync(dir, { recursive: true, force: true });
});

describe("reportMessage", () => {
  test("says plainly that a Grok Bot finished the task and shows the result", () => {
    const m = reportMessage(
      "gb-0123456789",
      "main",
      "find a part",
      "It is in stock at 12 dollars.",
    );
    expect(m).toContain("Grok Bot finished task gb-0123456789");
    expect(m).toContain('(bot "main")');
    expect(m).toContain("Here is the result.");
    expect(m).toContain('The task you gave it: "find a part"');
    expect(m).toContain("It is in stock at 12 dollars.");
  });

  test("a huge result is cut, and the cut is stated", () => {
    const m = reportMessage("gb-0123456789", "main", "t", "x".repeat(50_000));
    expect(m.length).toBeLessThan(13_500);
    expect(m).toContain("[result cut at 12000 characters]");
  });

  test("a long task is abbreviated, and quotes in it cannot break out of the line", () => {
    const m = reportMessage("gb-0123456789", "main", `say "hi" ${"y".repeat(2_000)}`, "r");
    expect(m).toContain('say \\"hi\\"');
    expect(m.length).toBeLessThan(1_200);
  });
});

describe("handleReport", () => {
  function rig() {
    let now = 5_000_000;
    const pending = new PendingTasks(dir, () => now);
    const woke: Array<{ text: string; said: string; origin?: PendingOrigin }> = [];
    const relay = {
      report: (text: string, said: string, _caller?: unknown, origin?: PendingOrigin) =>
        woke.push({ text, said, origin }),
    };
    return {
      pending,
      woke,
      advance: (ms: number) => {
        now += ms;
      },
      report: (id: string, result: string) =>
        handleReport({ pending, relay, now: () => now }, id, result),
    };
  }

  test("a pending id: delivered, recorded, and Edmund is woken once", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-aaaaaaaaaa", task: "look it up", bot: "main" });
    const out = r.report("gb-aaaaaaaaaa", "Found it.");
    expect(out).toEqual({ ok: true });
    expect(r.woke).toHaveLength(1);
    expect(r.woke[0]!.said).toBe("Grok Bot finished task gb-aaaaaaaaaa");
    expect(r.woke[0]!.text).toContain("Grok Bot finished task gb-aaaaaaaaaa");
    expect(r.woke[0]!.text).toContain("Found it.");
    expect(r.pending.lookup("gb-aaaaaaaaaa").status).toBe("reported");
  });

  test("the wake-up carries the origin the task was asked from; none when not recorded", () => {
    const r = rig();
    const origin = {
      sessionKey: "imessage:group:any;+;chat7",
      chatGuid: "any;+;chat7",
      isGroup: true,
    };
    r.pending.add({ replyId: "gb-0000000001", task: "from a group", bot: "main", origin });
    r.pending.add({ replyId: "gb-0000000002", task: "from nowhere known", bot: "main" });
    r.report("gb-0000000001", "ok");
    r.report("gb-0000000002", "ok");
    expect(r.woke.map((w) => w.origin)).toEqual([origin, undefined]);
  });

  test("an id nobody issued is rejected and wakes no one", () => {
    const r = rig();
    const out = r.report("gb-doesnotexist", "I made this up");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("no task with that reply_id");
    expect(r.woke).toHaveLength(0);
  });

  test("an expired id is rejected with its own message and wakes no one", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-bbbbbbbbbb", task: "t", bot: "main" });
    r.advance(PENDING_TTL_MS + 1);
    const out = r.report("gb-bbbbbbbbbb", "late");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("expired");
    expect(r.woke).toHaveLength(0);
  });

  test("a second report for the same id is acknowledged but wakes no one again", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-cccccccccc", task: "t", bot: "main" });
    r.report("gb-cccccccccc", "first");
    const again = r.report("gb-cccccccccc", "second, different");
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.text).toContain("already has the result");
    expect(r.woke).toHaveLength(1);
    const found = r.pending.lookup("gb-cccccccccc");
    expect(found.status === "reported" && found.task.result).toBe("first");
  });

  test("a task Edmund is blocked on (wait_for_result) is handed to that call, not queued as a wake-up", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-dddddddddd", task: "t", bot: "main", waitMs: 60_000 });
    const out = r.report("gb-dddddddddd", "answer for the waiting call");
    expect(out.ok).toBe(true);
    expect(r.woke).toHaveLength(0);
    const found = r.pending.lookup("gb-dddddddddd");
    expect(found.status === "reported" && found.task.result).toBe("answer for the waiting call");
  });

  test("a wait that has already given up does wake Edmund", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-eeeeeeeeee", task: "t", bot: "main", waitMs: 1_000 });
    r.advance(2_000);
    r.report("gb-eeeeeeeeee", "late but valid");
    expect(r.woke).toHaveLength(1);
  });

  test("a mangled id (case, quotes, spaces) still matches", () => {
    const r = rig();
    r.pending.add({ replyId: "gb-ffffffffff", task: "t", bot: "main" });
    expect(r.report(' "GB-FFFFFFFFFF" ', "ok").ok).toBe(true);
    expect(r.woke).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The whole loop: Edmund's tool -> mock Grok webhook -> the "Bot" calls the real
// connector listener's report_to_edmund -> a GrokReport inbound is enqueued in
// the owner's DM session.
// ---------------------------------------------------------------------------

type Enqueued = { key: string; msg: InboundMessage };

function startChannel(over: { turnRunning?: (k: string) => boolean } = {}) {
  const enqueued: Enqueued[] = [];
  const config = {
    paths: { data_dir: dir },
    grok: {
      enabled: true,
      handle: HANDLE,
      port: 0,
      token: TOKEN,
      auth_mode: "both",
      answer_timeout_ms: 25_000,
      slow_reply: "later",
      max_message_chars: 1000,
      max_reply_chars: 700,
      requests_per_minute: 600,
      asks_per_minute: 60,
      max_auth_failures: 10,
    },
  } as unknown as Config;
  const channel = createGrokChannel({
    config,
    pipeline: {
      enqueue: (key: string, msg: InboundMessage) => enqueued.push({ key, msg }),
    } as unknown as SessionPipeline,
    contacts: { canon: (h: string) => h } as unknown as ContactBook,
    turnRunning: over.turnRunning,
  });
  if (!channel) throw new Error("channel did not start");
  closers.push(() => channel.stop());
  return { channel, enqueued };
}

async function connector(port: number): Promise<Client> {
  const client = new Client({ name: "grok-bot", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
  closers.push(() => void client.close());
  return client;
}

const textOf = (r: unknown) =>
  ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n");

function edmundCtx(
  bots: Record<string, { webhook_url: string; key: string }>,
  group?: { chatGuid: string; members: string[] },
): ToolContext {
  const cfg = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { dm: [], groups: [] },
    identity: {},
    grok: { enabled: true, handle: HANDLE, token: TOKEN, bots },
  });
  cfg.paths.data_dir = dir;
  return {
    config: cfg,
    cron: null,
    chatDb: group
      ? { query: () => ({ all: () => group.members.map((handle) => ({ handle })) }) }
      : null,
    contacts: { canon: (h: string) => h },
    sessionKey: group ? `imessage:group:${group.chatGuid}` : dmKeyFor(HANDLE),
    chatGuids: group ? [group.chatGuid] : [],
    sandboxPath: dir,
    dataDir: dir,
    bgJobs: null,
    guestTier: null,
    // A group runs at the group tier, whoever is in it.
    sessionTier: group ? "contact" : "operator",
  } as unknown as ToolContext;
}

describe("callback round trip", () => {
  test("grokbot_task -> webhook -> report_to_edmund -> a GrokReport inbound in the owner's DM session", async () => {
    const { channel, enqueued } = startChannel();
    const client = await connector(channel.port);

    let payload: Record<string, string> = {};
    let auth: string | null = null;
    const webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        auth = req.headers.get("authorization");
        payload = await req.json();
        return new Response("{}", { status: 200 });
      },
    });
    closers.push(() => webhook.stop(true));

    const tool = grokBotTools(
      edmundCtx({ main: { webhook_url: `http://127.0.0.1:${webhook.port}/h`, key: BOT_KEY } }),
    )[0]!;
    const sent = await tool.handler(
      tool.inputSchema.parse({ task: "find the cheapest 0.4 nozzle" }),
    );
    expect(textOf(sent)).toContain("Grok Bot accepted it");
    expect(auth as string | null).toBe(`Bearer ${BOT_KEY}`);
    expect(payload.from).toBe("Edmund");
    const replyId = payload.reply_id as string;
    expect(replyId).toMatch(/^gb-/);

    // Nothing has woken Edmund yet.
    expect(enqueued).toHaveLength(0);

    // The Bot finishes and calls back through the real connector.
    const reply = await client.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: replyId, result: "Cheapest is 4.99 at the usual shop." },
    });
    expect(textOf(reply)).toBe("Thanks, delivered.");
    expect((reply as { isError?: boolean }).isError).toBeFalsy();

    expect(enqueued).toHaveLength(1);
    const { key, msg } = enqueued[0]!;
    expect(key).toBe(dmKeyFor(HANDLE));
    expect(msg.service).toBe(GROK_REPORT_SERVICE);
    expect(msg.rowId).toBeLessThan(0);
    expect(msg.fromHandle).toBe(HANDLE);
    expect(msg.isGroup).toBe(false);
    expect(msg.text).toContain(`Grok Bot finished task ${replyId}`);
    expect(msg.text).toContain("Cheapest is 4.99 at the usual shop.");
    expect(msg.text).toContain("find the cheapest 0.4 nozzle");

    // A repeat is harmless: told so, and Edmund is not woken twice.
    const again = await client.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: replyId, result: "again" },
    });
    expect(textOf(again)).toContain("already has the result");
    expect(enqueued).toHaveLength(1);
  });

  test("asked in a group the owner is in: the report wakes THAT group's session, as a group inbound", async () => {
    const { channel, enqueued } = startChannel();
    const client = await connector(channel.port);
    const GUID = "any;+;chat555000111";

    let payload: Record<string, string> = {};
    const webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        payload = await req.json();
        return new Response("{}", { status: 200 });
      },
    });
    closers.push(() => webhook.stop(true));

    const tool = grokBotTools(
      edmundCtx(
        { glep: { webhook_url: `http://127.0.0.1:${webhook.port}/h`, key: BOT_KEY } },
        { chatGuid: GUID, members: ["+15550100077", HANDLE] },
      ),
    )[0]!;
    const sent = await tool.handler(
      tool.inputSchema.parse({ task: "check the trail conditions", bot: "glep" }),
    );
    expect(textOf(sent)).toContain("Grok Bot accepted it");
    expect(textOf(sent)).toContain("arrives in this chat");
    const replyId = payload.reply_id as string;

    const reply = await client.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: replyId, result: "Muddy above the ridge; the lower loop is dry." },
    });
    expect(textOf(reply)).toBe("Thanks, delivered.");

    expect(enqueued).toHaveLength(1);
    const { key, msg } = enqueued[0]!;
    expect(key).toBe(`imessage:group:${GUID}`);
    expect(sessionKeyFor(msg, { canon: (h) => h })).toBe(key);
    expect(msg.isGroup).toBe(true);
    expect(msg.chatGuid).toBe(GUID);
    expect(msg.service).toBe(GROK_REPORT_SERVICE);
    expect(msg.rowId).toBeLessThan(0);
    expect(msg.text).toContain(`Grok Bot finished task ${replyId}`);
    expect(msg.text).toContain("Muddy above the ridge");
    expect(msg.text).toContain("check the trail conditions");
  });

  test("a task recorded before origins existed still wakes the owner's DM", async () => {
    const { channel, enqueued } = startChannel();
    const client = await connector(channel.port);
    // No origin on the line, as written by the previous version.
    new PendingTasks(dir).add({ replyId: "gb-legacy0001", task: "old task", bot: "main" });
    const reply = await client.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: "gb-legacy0001", result: "late result" },
    });
    expect(textOf(reply)).toBe("Thanks, delivered.");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.key).toBe(dmKeyFor(HANDLE));
    expect(enqueued[0]?.msg.isGroup).toBe(false);
  });

  test("a bogus reply_id is refused through the real listener and wakes no one", async () => {
    const { channel, enqueued } = startChannel();
    const client = await connector(channel.port);
    const r = await client.callTool({
      name: "report_to_edmund",
      arguments: { reply_id: "gb-0000000000", result: "pretend result" },
    });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toContain("no task with that reply_id");
    expect(enqueued).toHaveLength(0);
  });

  test("a wait_for_result call receives the Bot's report; Edmund is not woken separately", async () => {
    const { channel, enqueued } = startChannel();
    const client = await connector(channel.port);

    // The Bot calls back a moment after the webhook returns.
    const webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { reply_id: string };
        setTimeout(() => {
          // The test ends when the report reaches Edmund, which can be before
          // this call has its own reply. Closing the client then rejects it,
          // and with nothing to catch that the whole run exits 1.
          client
            .callTool({
              name: "report_to_edmund",
              arguments: { reply_id: body.reply_id, result: "Quick answer: yes." },
            })
            .catch(() => {});
        }, 50);
        return new Response("{}", { status: 200 });
      },
    });
    closers.push(() => webhook.stop(true));

    const tool = grokBotTools(
      edmundCtx({ main: { webhook_url: `http://127.0.0.1:${webhook.port}/h`, key: BOT_KEY } }),
      { pollMs: 10, maxWaitMs: 5_000 },
    )[0]!;
    const r = await tool.handler(tool.inputSchema.parse({ task: "quick", wait_for_result: true }));
    expect(textOf(r)).toContain("Quick answer: yes.");
    expect(enqueued).toHaveLength(0);
  });

  test("tell_edmund queues a fire-and-forget inbound and returns at once", async () => {
    const { channel, enqueued } = startChannel();
    const client = await connector(channel.port);
    const t0 = performance.now();
    const r = await client.callTool({
      name: "tell_edmund",
      arguments: { message: "connector test, no reply needed, reply KEEP_QUIET" },
    });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(textOf(r)).toBe("Got it, Edmund's on it.");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.key).toBe(dmKeyFor(HANDLE));
    expect(enqueued[0]!.msg.service).toBe(GROK_TELL_SERVICE);
    expect(enqueued[0]!.msg.rowId).toBeLessThan(0);
    expect(enqueued[0]!.msg.text).toBe("connector test, no reply needed, reply KEEP_QUIET");
  });

  test("check_edmund is fast, runs no turn, and reflects a running turn and texted answers", async () => {
    const dmKey = dmKeyFor(HANDLE);
    let busy = false;
    const { channel, enqueued } = startChannel({ turnRunning: (k) => busy && k === dmKey });
    new ExchangeLog(dir).record({
      atMs: Date.now() - 120_000,
      handle: HANDLE,
      said: "research a thing",
      reply: "Here is what I found.",
      via: "texted",
    });
    const client = await connector(channel.port);

    const t0 = performance.now();
    const quiet = textOf(await client.callTool({ name: "check_edmund", arguments: {} }));
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(quiet).toContain("not working on anything");
    expect(quiet).toContain("Here is what I found.");

    busy = true;
    const working = textOf(await client.callTool({ name: "check_edmund", arguments: {} }));
    expect(working).toContain("Edmund is working on something right now.");
    expect(enqueued).toHaveLength(0);
  });

  test("the listener serves exactly the four tools", async () => {
    const { channel } = startChannel();
    const client = await connector(channel.port);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "ask_edmund",
      "tell_edmund",
      "check_edmund",
      "report_to_edmund",
    ]);
  });
});
