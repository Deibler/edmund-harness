import { Database } from "bun:sqlite";
/**
 * The missed-name check for groups: code nominates an un-named group message,
 * Jev decides whether it is for the assistant, and a woken message reaches
 * his turn marked as un-named so he can decide whether to answer.
 *
 * Also pins the swipe-reply parent: iMessage stores it in
 * thread_originator_guid, which the watcher never read, so every inline reply
 * arrived with no parent (91 of 91 in the 90 days to 2026-09-24).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backlogGroups } from "../src/boot/catchup.ts";
import { entryToInbound, parsePendingLine, toPendingEntry } from "../src/bridge/session-queue.ts";
import { buildEnvelope } from "../src/channels/envelope.ts";
import { passesGroupRegate } from "../src/channels/turn.ts";
import { ConfigSchema } from "../src/config/config.ts";
import {
  AddressChecker,
  addressState,
  candidateReason,
  nameLikeWord,
  shouldWake,
} from "../src/gating/address-check.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { parseReplyGuid, readMessage } from "../src/imessage/watcher.ts";
import { askJev, readAnswers } from "../src/jev/client.ts";

const CREW = "any;+;crew";
const OTHER = "any;+;other";
const STRANGERS = "any;+;strangers";
const DM = "any;-;+15550100001";
const NOW = Date.now();
const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;
const min = 60_000;

const dir = mkdtempSync(join(tmpdir(), "address-check-"));
const dbPath = join(dir, "chat.db");
{
  const w = new Database(dbPath);
  w.exec("PRAGMA journal_mode = WAL");
  w.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
      is_from_me INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, service TEXT,
      associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, handle_id INTEGER DEFAULT 0,
      thread_originator_guid TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, total_bytes INTEGER, user_info BLOB);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat VALUES (1, '${CREW}', 'crew', 43), (2, '${OTHER}', 'other', 43),
      (3, '${STRANGERS}', 'strangers', 43), (4, '${DM}', '+15550100001', 45);
    INSERT INTO handle VALUES (1, '+15550100001'), (2, '+15550100002');
  `);
  const add = (
    row: number,
    chat: number,
    opts: {
      me?: boolean;
      handle?: number;
      at: number;
      text: string;
      thread?: string;
      assoc?: [string, number];
    },
  ) => {
    w.query(
      `INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id, service, thread_originator_guid,
         associated_message_guid, associated_message_type) VALUES (?, ?, ?, ?, ?, ?, 'iMessage', ?, ?, ?)`,
    ).run(
      row,
      `g${row}`,
      opts.text,
      appleNs(opts.at),
      opts.me ? 1 : 0,
      opts.me ? 0 : (opts.handle ?? 1),
      opts.thread ?? null,
      opts.assoc?.[0] ?? null,
      opts.assoc?.[1] ?? 0,
    );
    w.query("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, row);
  };
  add(1, 1, { me: true, at: NOW - 30 * min, text: "The sheet is done, 22 teams" });
  add(2, 1, { handle: 1, at: NOW - 29 * min, text: "nice" });
  add(3, 1, { me: true, at: NOW - 6 * min, text: "Rain starts around 3" });
  add(4, 1, { handle: 2, at: NOW - 1 * min, text: "ok so when does it stop" });
  add(5, 1, { handle: 1, at: NOW, text: "wait why 22", thread: "g1" });
  add(6, 1, { handle: 2, at: NOW, text: "Edmudn which exit do I take" });
  add(7, 1, { handle: 1, at: NOW, text: "love that", thread: "g1", assoc: ["p:0/g1", 2000] });
  add(8, 2, { me: true, at: NOW - 60 * min, text: "Morning" });
  add(9, 2, { handle: 1, at: NOW, text: "anyone up for lunch" });
  add(10, 3, { me: true, at: NOW - 2 * min, text: "Here you go" });
  add(11, 3, { handle: 2, at: NOW, text: "thanks, and what about tomorrow" });
  add(12, 4, { handle: 1, at: NOW, text: "what about tomorrow" });
  add(13, 1, { handle: 1, at: NOW, text: "edmund what about tomorrow" });
  w.close();
}
const chatDb = new ChatDb(dbPath);

function makeConfig(mode: "off" | "shadow" | "on", extra: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { groups: [CREW, OTHER] },
    identity: { names: ["edmund", "ed"] },
    keys: { openrouter: "test-key" },
    paths: { data_dir: dir },
    group_addressing: { mode, ...extra },
  });
}

const msg = (row: number): InboundMessage => {
  const m = readMessage(chatDb, row);
  if (!m) throw new Error(`fixture row ${row} missing`);
  return m;
};

/** A decisions endpoint that answers every call with these probabilities, and counts calls. */
function jev(addressed: number, wantsReply: number, status = 200) {
  const calls: unknown[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        answers: {
          addressed: { type: "noul", noul: addressed },
          wants_reply: { type: "noul", noul: wantsReply },
        },
        usage: { cost: 0.00005 },
      }),
      { status },
    );
  }) as unknown as typeof fetch;
  return { f, calls };
}

afterAll(() => {
  chatDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("swipe-reply parents", () => {
  test("an inline reply names its parent through thread_originator_guid", () => {
    expect(msg(5).replyToGuid).toBe("g1");
    expect(parseReplyGuid(null, 0, "PARENT")).toBe("PARENT");
  });

  test("a tapback on a threaded message is not a reply", () => {
    expect(parseReplyGuid("p:0/g1", 2000, "g1")).toBeNull();
  });

  test("the older associated-guid form still parses", () => {
    const guid = "0A1B2C3D-0000-4000-8000-000000000001";
    expect(parseReplyGuid(`p:0/${guid}`, 0, null)).toBe(guid);
  });
});

describe("which messages are asked about", () => {
  const config = makeConfig("shadow");

  test("a swipe-reply to the assistant", () => {
    expect(candidateReason(msg(5), chatDb, config)).toBe("reply-to-assistant");
  });

  test("a misspelled name, even long after he spoke", () => {
    expect(candidateReason(msg(6), chatDb, config)).toBe("name-like");
    expect(nameLikeWord("Edmudn which exit", ["edmund"])).toBe("edmudn");
    expect(nameLikeWord("where do you get that edmun", ["edmund"])).toBe("edmun");
    expect(nameLikeWord("Eemund", ["edmund"])).toBe("eemund");
  });

  test("short names are never matched loosely", () => {
    expect(nameLikeWord("Ted and Fred went home", ["ed", "eddy"])).toBeNull();
  });

  test("a message soon after he spoke, and not one long after", () => {
    expect(candidateReason(msg(4), chatDb, config)).toBe("after-assistant");
    expect(candidateReason(msg(9), chatDb, config)).toBeNull();
  });

  test("never a DM", () => {
    expect(candidateReason(msg(12), chatDb, config)).toBeNull();
  });
});

describe("what Jev is shown", () => {
  test("recent messages with senders as letters, the parent of a swipe-reply, and no handle", () => {
    const state = addressState(msg(5), chatDb, makeConfig("shadow")) as {
      recentMessages: { from: string; text: string }[];
      latestMessage: { from: string; text: string; repliesTo?: { from: string; text: string } };
    };
    expect(state.recentMessages.map((m) => m.from)).toContain("Edmund");
    expect(state.latestMessage.repliesTo).toEqual({
      from: "Edmund",
      text: "The sheet is done, 22 teams",
    });
    expect(JSON.stringify(state)).not.toContain("+1555");
  });
});

describe("deciding to wake him", () => {
  const config = makeConfig("on");

  test("soon after he spoke, only 'wants a reply' wakes him", () => {
    expect(shouldWake("after-assistant", { addressed: 0.95, wants_reply: 0.2 }, config)).toBe(
      false,
    );
    expect(shouldWake("after-assistant", { addressed: 0.3, wants_reply: 0.65 }, config)).toBe(true);
  });

  test("a misspelled name or a swipe-reply to him: 'said to him' is enough", () => {
    expect(shouldWake("name-like", { addressed: 0.8, wants_reply: 0.3 }, config)).toBe(true);
    expect(shouldWake("reply-to-assistant", { addressed: 0.8, wants_reply: 0.3 }, config)).toBe(
      true,
    );
  });
});

describe("the checker", () => {
  test("in 'on' mode a message Jev judges for him is handed over, marked un-named", async () => {
    const woken: InboundMessage[] = [];
    const { f } = jev(0.9, 0.85);
    const checker = new AddressChecker({
      config: makeConfig("on"),
      chatDb,
      fetch: f,
    });
    const d = await checker.consider(msg(4), (m) => woken.push(m));
    expect(d?.wake).toBe(true);
    expect(woken).toHaveLength(1);
    expect(woken[0]!.unnamedWake).toEqual({
      reason: "after-assistant",
      addressed: 0.9,
      wantsReply: 0.85,
    });
  });

  test("shadow mode records the decision and wakes nobody", async () => {
    const woken: InboundMessage[] = [];
    const checker = new AddressChecker({
      config: makeConfig("shadow"),
      chatDb,
      fetch: jev(0.9, 0.85).f,
    });
    expect((await checker.consider(msg(4), (m) => woken.push(m)))?.wake).toBe(true);
    expect(woken).toHaveLength(0);
  });

  test("an unregistered group, a DM and a named message are never sent to Jev", () => {
    const { f, calls } = jev(0.99, 0.99);
    const checker = new AddressChecker({
      config: makeConfig("on"),
      chatDb,
      fetch: f,
    });
    expect(candidateReason(msg(11), chatDb, makeConfig("on"))).toBe("after-assistant");
    expect(checker.consider(msg(11), () => {})).toBeNull();
    expect(checker.consider(msg(12), () => {})).toBeNull();
    expect(checker.consider(msg(13), () => {})).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("no answer from Jev means no wake", async () => {
    const woken: InboundMessage[] = [];
    const checker = new AddressChecker({
      config: makeConfig("on"),
      chatDb,
      fetch: jev(0.9, 0.9, 529).f,
      sleep: async () => {},
    });
    const d = await checker.consider(msg(4), (m) => woken.push(m));
    expect(d?.wake).toBe(false);
    expect(d?.error).toContain("529");
    expect(woken).toHaveLength(0);
  });

  test("the daily cap per group holds", async () => {
    const woken: InboundMessage[] = [];
    const checker = new AddressChecker({
      config: makeConfig("on", { max_wakes_per_group_per_day: 1 }),
      chatDb,
      fetch: jev(0.9, 0.9).f,
    });
    await checker.consider(msg(4), (m) => woken.push(m));
    await checker.consider(msg(6), (m) => woken.push(m));
    expect(woken).toHaveLength(1);
  });

  test("a handler that throws does not reject the check", async () => {
    const checker = new AddressChecker({
      config: makeConfig("on"),
      chatDb,
      fetch: jev(0.9, 0.9).f,
    });
    const route = () => {
      throw new Error("queue full");
    };
    expect((await checker.consider(msg(4), route))?.wake).toBe(true);
  });

  test("the decision record keeps scores and the row id, never the text", () => {
    const records = readFileSync(join(dir, "addressing.jsonl"), "utf8");
    expect(records).toContain('"row":4');
    expect(records).not.toContain("when does it stop");
    expect(records).not.toContain("+1555");
  });
});

describe("a woken message reaches the turn", () => {
  const wake = { reason: "after-assistant" as const, addressed: 0.9, wantsReply: 0.8 };

  test("it survives the pending queue and the durable ack", () => {
    const back = entryToInbound(
      parsePendingLine(JSON.stringify(toPendingEntry({ ...msg(4), unnamedWake: wake })))!,
    );
    expect(back?.unnamedWake).toEqual(wake);
    const junk = parsePendingLine(
      JSON.stringify({ ...toPendingEntry(msg(4)), unnamedWake: { reason: "whatever" } }),
    );
    expect(junk?.unnamedWake).toBeUndefined();
  });

  test("it passes the group re-gate; an un-named message without the mark does not", () => {
    expect(passesGroupRegate([{ ...msg(4), unnamedWake: wake }], [], ["edmund"])).toBe(true);
    expect(passesGroupRegate([msg(4)], [], ["edmund"])).toBe(false);
    expect(passesGroupRegate([msg(13)], [], ["edmund"])).toBe(true);
  });

  test("the envelope tells him he wasn't named and that staying quiet is his call", () => {
    const base = { senderLabel: "Friend", lastInboundMs: null, isGroup: true };
    const marked = buildEnvelope({ ...base, messages: [{ ...msg(4), unnamedWake: wake }] });
    expect(marked).toContain("Not named:");
    expect(marked).toContain("KEEP_QUIET");
    expect(buildEnvelope({ ...base, messages: [msg(4)] })).not.toContain("Not named:");
  });
});

describe("the Jev client", () => {
  test("retries an overload, then answers", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) return new Response("{}", { status: 529 });
      return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.7 } } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const res = await askJev(
      {},
      { q: { type: "noul", instructions: "?" } },
      { apiKey: "k", model: "m", fetch: f, sleep: async () => {} },
    );
    expect(res.answers.q).toBe(0.7);
    expect(res.attempts).toHaveLength(2);
  });

  test("a refused request is not retried", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      askJev(
        {},
        { q: { type: "noul", instructions: "?" } },
        { apiKey: "k", model: "m", fetch: f, sleep: async () => {} },
      ),
    ).rejects.toThrow("400");
    expect(n).toBe(1);
  });

  test("a missing answer is an error, not a zero", () => {
    expect(() => readAnswers({ answers: {} }, ["q"])).toThrow("missing");
  });
});

describe("both inbound paths run the check", () => {
  // 2026-09-24: after a restart the live watcher starts only once boot
  // catch-up drains. That took ten minutes, and the two un-named messages that
  // arrived in between went through catch-up's own gate, which had no check.
  const catchupDeps = (config: ReturnType<typeof makeConfig>) =>
    ({
      config,
      echoes: { isEcho: () => false },
      contacts: { displayName: () => null },
      state: { recordRouting: () => {} },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stubs for grouping
    }) as any;

  test("a backlog message Jev wakes him for joins its chat's batch, marked", async () => {
    const config = makeConfig("on");
    const checker = new AddressChecker({ config, chatDb, fetch: jev(0.9, 0.85).f });
    const groups = await backlogGroups([msg(4), msg(9)], catchupDeps(config), checker);
    const batches = [...groups.values()];
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((m) => m.rowId)).toEqual([4]);
    expect(batches[0]![0]!.unnamedWake?.reason).toBe("after-assistant");
  });

  test("without a wake, or in shadow mode, the backlog drops it as before", async () => {
    const on = makeConfig("on");
    const no = new AddressChecker({ config: on, chatDb, fetch: jev(0.2, 0.1).f });
    expect((await backlogGroups([msg(4)], catchupDeps(on), no)).size).toBe(0);
    const shadow = makeConfig("shadow");
    const quiet = new AddressChecker({ config: shadow, chatDb, fetch: jev(0.9, 0.9).f });
    expect((await backlogGroups([msg(4)], catchupDeps(shadow), quiet)).size).toBe(0);
  });

  test("the daemon hands the checker to catch-up and to the live watcher", () => {
    const main = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
    expect(main).toMatch(/runCatchUp\(\{[^}]*addressChecker,/);
    expect(main).toContain("void addressChecker.consider(msg, routeAccepted);");
    const catchup = readFileSync(join(import.meta.dir, "../src/boot/catchup.ts"), "utf8");
    expect(catchup).toContain("await backlogGroups(messages, deps, addressChecker)");
  });
});
