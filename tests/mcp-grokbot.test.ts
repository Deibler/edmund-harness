import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import { PendingTasks } from "../src/grok/pending.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { assembleCoreTools } from "../src/mcp/server.ts";
import { grokBotTools } from "../src/mcp/tools/grokbot.ts";
import type { SessionTier } from "../src/security/policy.ts";
import { dmKeyFor } from "../src/sessions/key.ts";

const OWNER = "+15550100001";
const OTHER = "+15550100002";
const TOKEN = "t".repeat(40);
const KEY_A = "xai-key-AAAA-secret-0123456789";
const KEY_B = "xai-key-BBBB-secret-9876543210";

let dir: string;
const servers: Array<{ stop: (force?: boolean) => void }> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-grokbot-"));
});
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

type Hit = { path: string; auth: string | null; body: Record<string, string> };

/** A stand-in for a Grok routine's webhook trigger. */
function mockBot(
  status = 200,
  onHit?: (hit: Hit) => void | Promise<void>,
): { url: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const hit: Hit = {
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: await req.json(),
      };
      hits.push(hit);
      await onHit?.(hit);
      return new Response("{}", { status });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

/** Just enough of ChatDb for getGroupParticipants: query(sql).all(chatGuid) -> handle rows. */
function fakeChatDb(members: string[] | "throw") {
  return {
    query: () => ({
      all: () => {
        if (members === "throw") throw new Error("chat.db is locked");
        return members.map((handle) => ({ handle }));
      },
    }),
  };
}

function ctx(
  over: {
    tier?: SessionTier;
    sessionKey?: string;
    enabled?: boolean;
    bots?: Record<string, { webhook_url: string; key: string }>;
    handle?: string;
    canon?: (h: string) => string;
    guest?: boolean;
    /** Handles chat.db lists as members of the session's group; "throw" breaks the query. */
    members?: string[] | "throw";
    /** `[owner].name`. Default "Sam Rivera"; "" leaves it unset. */
    ownerName?: string;
  } = {},
): ToolContext {
  const config = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { dm: [], groups: [] },
    identity: {},
    owner: { name: over.ownerName ?? "Sam Rivera" },
    grok: {
      enabled: over.enabled ?? true,
      handle: over.handle ?? OWNER,
      token: TOKEN,
      bots: over.bots ?? {},
    },
  });
  config.paths.data_dir = dir;
  return {
    config,
    cron: null,
    chatDb: over.members === undefined ? null : fakeChatDb(over.members),
    contacts: { canon: over.canon ?? ((h: string) => h) },
    sessionKey: over.sessionKey ?? dmKeyFor(OWNER),
    chatGuids: [],
    sandboxPath: dir,
    dataDir: dir,
    bgJobs: null,
    guestTier: over.guest ? "keyed-guest" : null,
    sessionTier: over.tier ?? "operator",
  } as unknown as ToolContext;
}

function tool(c: ToolContext, deps?: Parameters<typeof grokBotTools>[1]) {
  const t = grokBotTools(c, deps)[0];
  if (!t) throw new Error("grokbot_task not registered");
  return (args: Record<string, unknown>) => t.handler(t.inputSchema.parse(args));
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

describe("grokbot_task registration (only the owner's own DM)", () => {
  const bots = { main: { webhook_url: "http://127.0.0.1:9/h", key: KEY_A } };

  test("registered for the owner's operator DM session", () => {
    expect(grokBotTools(ctx({ bots })).map((t) => t.name)).toEqual(["grokbot_task"]);
  });

  test("registered even with no bots configured (so the model can say what to set up)", () => {
    expect(grokBotTools(ctx()).map((t) => t.name)).toEqual(["grokbot_task"]);
  });

  test("not registered when the Grok channel is off", () => {
    expect(grokBotTools(ctx({ bots, enabled: false }))).toEqual([]);
  });

  test("not registered without a configured owner handle", () => {
    expect(grokBotTools(ctx({ bots, handle: "" }))).toEqual([]);
  });

  test("not registered in someone else's DM, even at operator tier", () => {
    expect(grokBotTools(ctx({ bots, sessionKey: dmKeyFor(OTHER) }))).toEqual([]);
  });

  test("not registered in a group chat whose members cannot be read (no chat.db)", () => {
    expect(grokBotTools(ctx({ bots, sessionKey: "imessage:group:chat123" }))).toEqual([]);
  });

  test.each(["contact", "vouched", "keyed-guest"] as const)(
    "not registered at the %s tier, even in the owner's DM key",
    (tier) => {
      expect(grokBotTools(ctx({ bots, tier }))).toEqual([]);
    },
  );

  test("the owner's email and phone number are one person (canonical handle)", () => {
    const canon = (h: string) => (h === "owner@example.com" ? OWNER : h);
    expect(
      grokBotTools(ctx({ bots, handle: "owner@example.com", canon })).map((t) => t.name),
    ).toEqual(["grokbot_task"]);
  });

  test("assembleCoreTools: owner DM gets it; contact tier, other DMs, guests and sub-agents do not", () => {
    const names = (c: ToolContext) => new Set(assembleCoreTools(c).map((t) => t.name));
    expect(names(ctx({ bots })).has("grokbot_task")).toBe(true);
    expect(names(ctx({ bots, tier: "contact" })).has("grokbot_task")).toBe(false);
    expect(names(ctx({ bots, sessionKey: dmKeyFor(OTHER) })).has("grokbot_task")).toBe(false);
    expect(names(ctx({ bots, guest: true, tier: "keyed-guest" })).has("grokbot_task")).toBe(false);
    expect(names(ctx({ bots, enabled: false })).has("grokbot_task")).toBe(false);
  });

  test("a sub-agent (EDMUND_AGENT=1) never gets it, even on the owner's DM key", () => {
    const before = process.env.EDMUND_AGENT;
    process.env.EDMUND_AGENT = "1";
    try {
      expect(assembleCoreTools(ctx({ bots })).some((t) => t.name === "grokbot_task")).toBe(false);
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "EDMUND_AGENT");
      else process.env.EDMUND_AGENT = before;
    }
  });

  test("the description tells Edmund it spends the owner's usage and not to poll", () => {
    const d = grokBotTools(ctx({ bots }))[0]?.description ?? "";
    expect(d).toContain("spends Sam's Grok usage");
    expect(d).toContain("Do not poll");
    expect(d).toContain("Grok Bot finished task");
  });
});

describe("grokbot_task registration in group chats (only where the owner is a member)", () => {
  const bots = { main: { webhook_url: "http://127.0.0.1:9/h", key: KEY_A } };
  const GROUP = "imessage:group:any;+;chat123456789";
  const group = (over: Parameters<typeof ctx>[0] = {}) =>
    ctx({ bots, sessionKey: GROUP, tier: "contact", members: [OTHER, OWNER], ...over });

  test("registered in a group the owner is in; a group runs at the contact tier", () => {
    expect(grokBotTools(group()).map((t) => t.name)).toEqual(["grokbot_task"]);
    expect(grokBotTools(group({ tier: "operator" })).map((t) => t.name)).toEqual(["grokbot_task"]);
  });

  test("not registered in a group the owner is not in", () => {
    expect(grokBotTools(group({ members: [OTHER, "+15550100003"] }))).toEqual([]);
    expect(grokBotTools(group({ members: [] }))).toEqual([]);
  });

  test("the owner's phone and email are one person when matching the members", () => {
    const canon = (h: string) => (h === "owner@example.com" ? OWNER : h);
    expect(grokBotTools(group({ handle: "owner@example.com", canon })).map((t) => t.name)).toEqual([
      "grokbot_task",
    ]);
    expect(
      grokBotTools(group({ members: ["owner@example.com"], canon })).map((t) => t.name),
    ).toEqual(["grokbot_task"]);
  });

  test("fails closed: a chat.db error, no owner handle, or the channel off is no tool", () => {
    expect(grokBotTools(group({ members: "throw" }))).toEqual([]);
    expect(grokBotTools(group({ handle: "" }))).toEqual([]);
    expect(grokBotTools(group({ enabled: false }))).toEqual([]);
  });

  test("never for a guest tier, even in a group with the owner", () => {
    expect(grokBotTools(group({ tier: "keyed-guest", guest: true }))).toEqual([]);
    expect(grokBotTools(group({ tier: "vouched" }))).toEqual([]);
  });

  test("only iMessage groups: SMS and orchestrator groups do not get it", () => {
    expect(grokBotTools(group({ sessionKey: "sms:group:CH123" }))).toEqual([]);
    expect(grokBotTools(group({ sessionKey: "orch:desmond:group:any;+;chat1" }))).toEqual([]);
  });

  test("another person's DM stays closed even if the lookup would list the owner", () => {
    expect(grokBotTools(ctx({ bots, sessionKey: dmKeyFor(OTHER), members: [OWNER] }))).toEqual([]);
  });

  test("assembleCoreTools: the contact-tier group session keeps it (not in CONTACT_TIER_EXCLUDED)", () => {
    const names = (c: ToolContext) => new Set(assembleCoreTools(c).map((t) => t.name));
    expect(names(group()).has("grokbot_task")).toBe(true);
    expect(names(group({ members: [OTHER] })).has("grokbot_task")).toBe(false);
    expect(names(group({ tier: "vouched", guest: true })).has("grokbot_task")).toBe(false);
  });

  test("the description reads fine in a group: no 'tell <the owner>', and says who may ask", () => {
    const d = grokBotTools(group())[0]?.description ?? "";
    expect(d).not.toMatch(/tell Sam/i);
    expect(d).toContain("In a group chat, only when Sam asks");
    expect(d).toContain("in this same chat");
  });

  test("the task records where it was asked from: the group session, chat guid, isGroup", async () => {
    const bot = mockBot();
    const c = group({ bots: { main: { webhook_url: bot.url, key: KEY_A } } });
    c.chatGuids = ["any;+;chat123456789"];
    const r = await tool(c)({ task: "watch the gate and tell the room" });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).not.toMatch(/Tell Sam/);
    const found = new PendingTasks(dir).lookup(bot.hits[0]?.body.reply_id as string);
    expect(found.status === "pending" && found.task.origin).toEqual({
      sessionKey: GROUP,
      chatGuid: "any;+;chat123456789",
      isGroup: true,
    });
  });

  test("a group task falls back to the key's own guid when chatGuids is empty", async () => {
    const bot = mockBot();
    const c = group({ bots: { main: { webhook_url: bot.url, key: KEY_A } } });
    await tool(c)({ task: "t" });
    const found = new PendingTasks(dir).lookup(bot.hits[0]?.body.reply_id as string);
    expect(found.status === "pending" && found.task.origin?.chatGuid).toBe("any;+;chat123456789");
  });

  test("the owner leaving the group after startup stops the call and posts nothing", async () => {
    const bot = mockBot();
    const c = group({ bots: { main: { webhook_url: bot.url, key: KEY_A } } });
    const handler = tool(c); // registered while the owner was a member
    c.chatDb = fakeChatDb([OTHER]) as unknown as ToolContext["chatDb"];
    const r = await handler({ task: "t" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(
      "Sam is not in this chat, so Sam's Grok Bots are not available here.",
    );
    expect(bot.hits).toHaveLength(0);
    expect(new PendingTasks(dir).open()).toEqual([]);
  });

  test("the owner's own DM task records a DM origin", async () => {
    const bot = mockBot();
    await tool(ctx({ bots: { main: { webhook_url: bot.url, key: KEY_A } } }))({ task: "t" });
    const found = new PendingTasks(dir).lookup(bot.hits[0]?.body.reply_id as string);
    expect(found.status === "pending" && found.task.origin).toEqual({
      sessionKey: dmKeyFor(OWNER),
      chatGuid: "",
      isGroup: false,
    });
  });
});

describe("grokbot_task: the owner is named from [owner].name, never from the source", () => {
  const bots = { main: { webhook_url: "https://example.com/hook", key: KEY_A } };

  test("the first name in [owner].name is the one the text uses", () => {
    const d = grokBotTools(ctx({ bots, ownerName: "  Dana Example  " }))[0]?.description ?? "";
    expect(d).toContain("one of Dana's Grok Bots");
    expect(d).not.toContain("Example");
    expect(d).not.toContain("Sam");
  });

  test("with no [owner].name it says the owner, and starts a sentence with a capital", async () => {
    const c = ctx({ ownerName: "" });
    const d = grokBotTools(ctx({ bots, ownerName: "" }))[0]?.description ?? "";
    expect(d).toContain("one of the owner's Grok Bots");
    expect(d).toContain("only when the owner asks");
    expect(textOf(await tool(c)({ task: "do a thing" }))).toContain(
      "The owner has to do this once",
    );
  });
});

describe("grokbot_task: no bots configured", () => {
  test("says what the owner has to set up, without any URL or key", async () => {
    const r = await tool(ctx())({ task: "do a thing" });
    expect(r.isError).toBe(true);
    const out = textOf(r);
    expect(out).toContain("No Grok Bot is set up");
    expect(out).toContain("Sam has to do this once");
    expect(out).toContain("Set up a Grok Bot routine for Edmund");
    expect(out).toContain("report_to_edmund");
    expect(out).toContain("[grok.bots.<name>]");
    expect(out).toContain("webhook_url");
    expect(out).not.toContain("setup.md"); // no file yet
  });

  test("points at the paste-ready setup file when it exists", async () => {
    mkdirSync(join(dir, "grok"), { recursive: true });
    writeFileSync(join(dir, "grok", "setup.md"), "steps");
    const out = textOf(await tool(ctx())({ task: "do a thing" }));
    expect(out).toContain(join(dir, "grok", "setup.md"));
  });

  test("nothing is recorded as pending", async () => {
    await tool(ctx())({ task: "do a thing" });
    expect(new PendingTasks(dir).open()).toEqual([]);
  });
});

describe("grokbot_task: handing off a task", () => {
  test("POSTs the documented JSON with the bearer key, records the id, says it was accepted", async () => {
    const bot = mockBot();
    const r = await tool(ctx({ bots: { main: { webhook_url: `${bot.url}/hook/1`, key: KEY_A } } }))(
      {
        task: "price a 12 inch pizza oven",
      },
    );
    expect(r.isError).toBeUndefined();
    expect(bot.hits).toHaveLength(1);
    const hit = bot.hits[0]!;
    expect(hit.path).toBe("/hook/1");
    expect(hit.auth).toBe(`Bearer ${KEY_A}`);
    expect(hit.body.task).toBe("price a 12 inch pizza oven");
    expect(hit.body.from).toBe("Edmund");
    expect(hit.body.reply_id).toMatch(/^gb-[0-9a-f]{10}$/);
    expect(hit.body.reply_instructions).toBe(
      "When done, call the report_to_edmund tool on the Edmund connector with this reply_id and your result. If you can't, say why in the result.",
    );
    expect(Object.keys(hit.body).sort()).toEqual([
      "from",
      "reply_id",
      "reply_instructions",
      "task",
    ]);

    const out = textOf(r);
    expect(out).toContain("Grok Bot accepted it");
    expect(out).toContain(hit.body.reply_id as string);
    expect(out).not.toContain(KEY_A);
    expect(out).not.toContain(bot.url);

    const found = new PendingTasks(dir).lookup(hit.body.reply_id as string);
    expect(found.status).toBe("pending");
    if (found.status === "pending") {
      expect(found.task.task).toBe("price a 12 inch pizza oven");
      expect(found.task.bot).toBe("main");
      expect(found.task.expiresMs - found.task.createdMs).toBe(24 * 60 * 60_000);
      expect(found.task.waitUntilMs).toBe(0);
    }
  });

  test("the id is on file BEFORE the webhook is called (a fast Bot can answer at once)", async () => {
    let status = "";
    const bot = mockBot(200, (hit) => {
      status = new PendingTasks(dir).lookup(hit.body.reply_id as string).status;
    });
    await tool(ctx({ bots: { main: { webhook_url: bot.url, key: KEY_A } } }))({ task: "t" });
    expect(status).toBe("pending");
  });

  test.each([
    [401, "rejected the key"],
    [404, "no routine"],
    [429, "rate limiting"],
    [500, "server error"],
  ])("HTTP %i is a clear error, leaves nothing pending, leaks nothing", async (code, phrase) => {
    const bot = mockBot(code);
    const r = await tool(
      ctx({ bots: { main: { webhook_url: `${bot.url}/secret/path`, key: KEY_A } } }),
    )({
      task: "t",
    });
    expect(r.isError).toBe(true);
    const out = textOf(r);
    expect(out).toContain(phrase);
    expect(out).not.toContain(KEY_A);
    expect(out).not.toContain("secret/path");
    expect(new PendingTasks(dir).open()).toEqual([]);
  });

  test("an unreachable webhook is an error, not a throw", async () => {
    const r = await tool(
      ctx({ bots: { main: { webhook_url: "http://127.0.0.1:1/h", key: KEY_A } } }),
    )({ task: "t" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Could not reach Grok");
    expect(new PendingTasks(dir).open()).toEqual([]);
  });

  test("rejects an empty or oversized task before any request is made", () => {
    const t = grokBotTools(
      ctx({ bots: { main: { webhook_url: "http://127.0.0.1:1/h", key: KEY_A } } }),
    )[0]!;
    expect(t.inputSchema.safeParse({ task: "" }).success).toBe(false);
    expect(t.inputSchema.safeParse({ task: "x".repeat(8_001) }).success).toBe(false);
    expect(t.inputSchema.safeParse({ task: "x".repeat(8_000) }).success).toBe(true);
  });
});

describe("grokbot_task: choosing a bot", () => {
  function two() {
    const a = mockBot();
    const b = mockBot();
    const bots = {
      alpha: { webhook_url: a.url, key: KEY_A },
      Beta: { webhook_url: b.url, key: KEY_B },
    };
    return { a, b, bots };
  }

  test("a named bot gets the task and its own key (name match ignores case)", async () => {
    const { a, b, bots } = two();
    await tool(ctx({ bots }))({ task: "t1", bot: "beta" });
    expect(a.hits).toHaveLength(0);
    expect(b.hits).toHaveLength(1);
    expect(b.hits[0]!.auth).toBe(`Bearer ${KEY_B}`);
    expect(new PendingTasks(dir).open()[0]?.bot).toBe("Beta");
  });

  test("two bots and no name asks which, listing names only", async () => {
    const { a, b, bots } = two();
    const r = await tool(ctx({ bots }))({ task: "t" });
    expect(r.isError).toBe(true);
    const out = textOf(r);
    expect(out).toContain("alpha");
    expect(out).toContain("Beta");
    expect(out).not.toContain(KEY_A);
    expect(out).not.toContain(a.url);
    expect(a.hits.length + b.hits.length).toBe(0);
  });

  test("a bot called 'default' is used when none is named", async () => {
    const d = mockBot();
    const o = mockBot();
    await tool(
      ctx({
        bots: {
          other: { webhook_url: o.url, key: KEY_B },
          default: { webhook_url: d.url, key: KEY_A },
        },
      }),
    )({ task: "t" });
    expect(d.hits).toHaveLength(1);
    expect(o.hits).toHaveLength(0);
  });

  test("an unknown name lists the configured ones and sends nothing", async () => {
    const { a, b, bots } = two();
    const r = await tool(ctx({ bots }))({ task: "t", bot: "gamma" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('No Grok Bot named "gamma"');
    expect(textOf(r)).toContain("alpha, Beta");
    expect(a.hits.length + b.hits.length).toBe(0);
  });
});

describe("grokbot_task: wait_for_result", () => {
  test("returns the Bot's result when the callback lands while waiting", async () => {
    // The webhook stands in for the Bot: shortly after the POST it "calls back",
    // which the daemon would record in the shared pending file.
    const bot = mockBot(200, (hit) => {
      setTimeout(() => {
        new PendingTasks(dir).complete(hit.body.reply_id as string, "It costs 349 dollars.");
      }, 40);
    });
    const r = await tool(ctx({ bots: { main: { webhook_url: bot.url, key: KEY_A } } }), {
      pollMs: 10,
      maxWaitMs: 5_000,
    })({ task: "price it", wait_for_result: true });
    expect(r.isError).toBeUndefined();
    const out = textOf(r);
    expect(out).toContain("finished task");
    expect(out).toContain("It costs 349 dollars.");
  });

  test("marks the task as waited-on, so the callback does not also wake Edmund", async () => {
    let waitUntil = 0;
    const bot = mockBot(200, (hit) => {
      const found = new PendingTasks(dir).lookup(hit.body.reply_id as string);
      if (found.status === "pending") waitUntil = found.task.waitUntilMs;
      new PendingTasks(dir).complete(hit.body.reply_id as string, "done");
    });
    await tool(ctx({ bots: { main: { webhook_url: bot.url, key: KEY_A } } }), {
      pollMs: 5,
      maxWaitMs: 5_000,
    })({ task: "t", wait_for_result: true });
    expect(waitUntil).toBeGreaterThan(Date.now());
  });

  test("gives up after the limit: says it is still running and lets a late callback wake Edmund", async () => {
    const bot = mockBot();
    const r = await tool(ctx({ bots: { main: { webhook_url: bot.url, key: KEY_A } } }), {
      pollMs: 10,
      maxWaitMs: 80,
    })({ task: "slow one", wait_for_result: true });
    expect(r.isError).toBeUndefined();
    const out = textOf(r);
    expect(out).toContain("has not finished");
    expect(out).toContain("Grok Bot finished task");
    const id = bot.hits[0]!.body.reply_id as string;
    const found = new PendingTasks(dir).lookup(id);
    expect(found.status).toBe("pending");
    if (found.status === "pending") expect(found.task.waitUntilMs).toBe(0);
  });

  test("a report that lands in the gap after the last poll is still returned", async () => {
    let id = "";
    const bot = mockBot(200, (hit) => {
      id = hit.body.reply_id as string;
    });
    const r = await tool(ctx({ bots: { main: { webhook_url: bot.url, key: KEY_A } } }), {
      pollMs: 1,
      maxWaitMs: 30,
      // The result arrives while the loop is on its last sleep.
      sleep: async () => {
        new PendingTasks(dir).complete(id, "just in time");
        await new Promise((res) => setTimeout(res, 40));
      },
    })({ task: "t", wait_for_result: true });
    expect(textOf(r)).toContain("just in time");
  });

  test("a refused webhook does not wait at all", async () => {
    const bot = mockBot(401);
    const t0 = performance.now();
    const r = await tool(ctx({ bots: { main: { webhook_url: bot.url, key: KEY_A } } }), {
      maxWaitMs: 60_000,
    })({ task: "t", wait_for_result: true });
    expect(r.isError).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
