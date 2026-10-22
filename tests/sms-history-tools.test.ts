import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { historyTools } from "../src/mcp/tools/history.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { SmsStore } from "../src/sms/store.ts";

/**
 * The history tools read chat.db, which has no rows for a Twilio
 * conversation. On an SMS group holding dozens of messages,
 * get_thread_context answered "no earlier messages in this chat", and a
 * scheduled reminder told to check the thread for pushback before sending
 * checked nothing. These drive the real handlers on SMS sessions with a
 * chat.db that throws when touched: delete the SMS branch in history.ts and
 * they go red.
 */

const GROUP = "CH00000000000000000000000000000001";
const GROUP_KEY = `sms:group:${GROUP}`;
const ALEX = "+15550100001";
const SAM = "+15550100002";

const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  paths: { chat_db: "/nonexistent/never/chat.db" },
});

const names: Record<string, string> = { [ALEX]: "Alex", [SAM]: "Sam" };
const contacts = {
  displayName: (h: string) => names[h] ?? null,
  label: (h: string) => names[h] ?? null,
} as unknown as ContactBook;

let dataDir: string;
const T0 = Date.UTC(2026, 8, 26, 23, 0, 0);

function ctxFor(sessionKey: string): ToolContext {
  return {
    config,
    sessionKey,
    chatGuids: [],
    sandboxPath: dataDir,
    dataDir,
    guestTier: null,
    sessionTier: "operator",
    get chatDb(): never {
      throw new Error("chat.db must not be touched on an SMS session");
    },
    contacts,
    cron: undefined,
    bgJobs: undefined,
  } as unknown as ToolContext;
}

async function call(sessionKey: string, name: string, args: Record<string, unknown> = {}) {
  const def = historyTools(ctxFor(sessionKey)).find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  const res = await def.handler(def.inputSchema.parse(args));
  return { isError: res.isError ?? false, text: String(res.content[0]!.text) };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sms-history-"));
  const store = new SmsStore(dataDir);
  const rows: [string | null, string][] = [
    [ALEX, "remind us thursday about the beer garden"],
    [null, "Locked in for Thursday."],
    [SAM, "she's into Jordan and his weird eggs"],
    [ALEX, "nobody tell Jordan"],
    [SAM, "Oops that's mine"],
  ];
  rows.forEach(([from, body], i) => {
    store.record({
      conversation: GROUP,
      direction: from ? "in" : "out",
      fromHandle: from ?? undefined,
      body,
      messageSid: `IM${i}`,
      atMs: T0 + i * 60_000,
    });
  });
  store.record({
    conversation: ALEX,
    direction: "in",
    fromHandle: ALEX,
    body: "dm only: the gate code is 4471",
    messageSid: "SMdm",
    atMs: T0,
  });
  store.close();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("history tools on an SMS group", () => {
  test("get_thread_context returns the transcript, speaker-tagged", async () => {
    const res = await call(GROUP_KEY, "get_thread_context", { limit: 30 });
    expect(res.isError).toBe(false);
    expect(res.text).not.toContain("no earlier messages");
    expect(res.text).toContain("[Alex · ");
    expect(res.text).toContain("[You · ");
    expect(res.text).toContain("[Sam · ");
    expect(res.text).toContain("she's into Jordan and his weird eggs");
    // Never another conversation's messages.
    expect(res.text).not.toContain("gate code");
  });

  test("get_thread_context pages back and says how much is left", async () => {
    const res = await call(GROUP_KEY, "get_thread_context", { limit: 2 });
    expect(res.text).toContain("Oops that's mine");
    expect(res.text).not.toContain("remind us thursday");
    expect(res.text).toContain("3 earlier messages exist");
    const anchored = await call(GROUP_KEY, "get_thread_context", {
      limit: 30,
      before_msg_guid: "sms-IM2",
    });
    expect(anchored.text).toContain("remind us thursday");
    expect(anchored.text).not.toContain("weird eggs");
  });

  test("search_history finds by text and by sender, and get_message opens a hit", async () => {
    const byText = await call(GROUP_KEY, "search_history", { query: "WEIRD EGGS" });
    expect(byText.text).toContain("sms-IM2");
    expect(byText.text).toContain("Sam: she's into Jordan");
    const bySender = await call(GROUP_KEY, "search_history", { sender: ALEX });
    expect(bySender.text).toContain("nobody tell Jordan");
    expect(bySender.text).not.toContain("Oops");
    const none = await call(GROUP_KEY, "search_history", { query: "lasagna" });
    expect(none.text).toContain("no matches");
    const msg = await call(GROUP_KEY, "get_message", { msg_guid: "sms-IM2" });
    expect(msg.text).toContain("she's into Jordan and his weird eggs");
  });

  test("search treats LIKE wildcards in the query as literal text", async () => {
    const res = await call(GROUP_KEY, "search_history", { query: "%" });
    expect(res.text).toContain("no matches");
  });

  test("catch_me_up returns what was said since the anchor", async () => {
    const res = await call(GROUP_KEY, "catch_me_up", { since: T0 + 90_000 });
    expect(res.text).toContain("3 msgs");
    expect(res.text).toContain("nobody tell Jordan");
    expect(res.text).not.toContain("Locked in");
  });

  test("list_attachments says media is not stored instead of 'no attachments'", async () => {
    const res = await call(GROUP_KEY, "list_attachments");
    expect(res.text).toContain("not downloaded");
  });
});

describe("history tools on an SMS DM", () => {
  test("read the person's SMS transcript, not the group's", async () => {
    const res = await call(`sms:dm:${ALEX}`, "get_thread_context", { limit: 30 });
    expect(res.text).toContain("gate code is 4471");
    expect(res.text).not.toContain("weird eggs");
  });
});
