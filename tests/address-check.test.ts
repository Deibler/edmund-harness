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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backlogGroups } from "../src/boot/catchup.ts";
import { entryToInbound, parsePendingLine, toPendingEntry } from "../src/bridge/session-queue.ts";
import { buildEnvelope } from "../src/channels/envelope.ts";
import { passesGroupRegate } from "../src/channels/turn.ts";
import { ConfigSchema } from "../src/config/config.ts";
import {
  ADDRESS_QUESTIONS_VERSION,
  AddressChecker,
  type RateBand,
  addressState,
  candidateReason,
  lastEngagedRow,
  loadCalibration,
  measuredRate,
  nameLikeWord,
  opensWithOtherMember,
  rateBands,
  shouldWake,
} from "../src/gating/address-check.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { parseReplyGuid, readMessage } from "../src/imessage/watcher.ts";
import { askJev, readAnswers } from "../src/jev/client.ts";

const CREW = "any;+;crew";
const OTHER = "any;+;other";
const STRANGERS = "any;+;strangers";
const RUN = "any;+;run";
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
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, total_bytes INTEGER, user_info BLOB);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO chat VALUES (1, '${CREW}', 'crew', 43), (2, '${OTHER}', 'other', 43),
      (3, '${STRANGERS}', 'strangers', 43), (4, '${DM}', '+15550100001', 45), (5, '${RUN}', 'run', 43);
    INSERT INTO handle VALUES (1, '+15550100001'), (2, '+15550100002');
    INSERT INTO chat_handle_join VALUES (1, 1), (1, 2), (5, 1), (5, 2);
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
  // RUN: one person keeps talking to him without his name, then names someone else.
  add(20, 5, { handle: 1, at: NOW - 9 * min, text: "edmund what's the score" });
  add(21, 5, { me: true, at: NOW - 8.5 * min, text: "3-1" });
  add(22, 5, { handle: 1, at: NOW - 8 * min, text: "who scored" });
  add(23, 5, { me: true, at: NOW - 7.5 * min, text: "Smith, twice" });
  add(24, 5, { handle: 1, at: NOW - 7 * min, text: "and the other one" });
  add(25, 5, { me: true, at: NOW - 6.5 * min, text: "Jones" });
  add(26, 5, { handle: 1, at: NOW - 6 * min, text: "nice, when's the next game" });
  add(27, 5, { handle: 1, at: NOW - 5.5 * min, text: "Sam who's driving tonight?" });
  add(28, 5, { handle: 2, at: NOW - 5 * min, text: "Sam here, I can drive" });
  add(29, 5, { handle: 1, at: NOW - 4.5 * min, text: "who's driving Sam" });
  add(30, 5, { handle: 1, at: NOW - 4 * min, text: "edmund thanks" });
  add(31, 5, { handle: 1, at: NOW - 3.5 * min, text: "one more thing" });
  add(32, 5, { handle: 2, at: NOW - 3 * min, text: "ok", thread: "g25" });
  add(33, 5, { handle: 1, at: NOW - 2.5 * min, text: "what about Sunday" });
  w.close();
}
const chatDb = new ChatDb(dbPath);

function makeConfig(
  mode: "off" | "shadow" | "on",
  extra: Record<string, unknown> = {},
  dataDir = dir,
) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: { groups: [CREW, OTHER, RUN] },
    identity: { names: ["edmund", "ed"] },
    keys: { openrouter: "test-key" },
    paths: { data_dir: dataDir },
    group_addressing: { mode, ...extra },
  });
}

/** A config with its own decision log, and optionally a measured table. */
function freshConfig(rates?: RateBand[]) {
  const d = mkdtempSync(join(dir, "fresh-"));
  if (rates) {
    mkdirSync(join(d, "addressing"), { recursive: true });
    writeFileSync(
      join(d, "addressing", `calibration-${ADDRESS_QUESTIONS_VERSION}.json`),
      JSON.stringify({ version: ADDRESS_QUESTIONS_VERSION, rates }),
    );
  }
  return makeConfig("on", {}, d);
}

const band = (from: number, n: number, yes: number): RateBand => ({
  from,
  to: from + 0.1,
  n,
  yes,
  rate: (yes + 1) / (n + 2),
});

const contacts = {
  displayName: (h: string) =>
    h === "+15550100001" ? "Alex Kim" : h === "+15550100002" ? "Sam Rivera" : null,
};

const msg = (row: number): InboundMessage => {
  const m = readMessage(chatDb, row);
  if (!m) throw new Error(`fixture row ${row} missing`);
  return m;
};

/** A decisions endpoint that answers every call with these probabilities, and counts calls.
 *  `delays[i]` holds the i-th answer back that many ms, so answers can arrive out of order. */
function jev(addressed: number, wantsReply: number, status = 200, delays: number[] = []) {
  const calls: unknown[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const wait = delays[calls.length] ?? 0;
    calls.push(JSON.parse(String(init.body)));
    if (wait > 0) await Bun.sleep(wait);
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

  test("soon after he spoke, 'wants a reply' wakes him only with some 'said to him'", () => {
    const wake = (addressed: number, wants_reply: number) =>
      shouldWake("after-assistant", { addressed, wants_reply }, config);
    expect(wake(0.95, 0.2)).toBe(false);
    // A friend asking a friend: wants a reply, not from him.
    expect(wake(0.3, 0.9)).toBe(false);
    // 0.6-0.7 was for him 18% of the time.
    expect(wake(0.6, 0.65)).toBe(false);
    expect(wake(0.6, 0.75)).toBe(true);
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
      streak: 1,
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
    const first = JSON.parse(records.split("\n")[0]!);
    for (const k of ["rate", "rateSource", "streak", "streakBudget", "overBudget", "woke"]) {
      expect(first).toHaveProperty(k);
    }
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
    expect(marked).not.toContain("in a row");
    expect(buildEnvelope({ ...base, messages: [msg(4)] })).not.toContain("Not named:");
  });

  test("deep in an un-named run, the envelope says how deep", () => {
    const base = { senderLabel: "Friend", lastInboundMs: null, isGroup: true };
    const third = buildEnvelope({
      ...base,
      messages: [{ ...msg(4), unnamedWake: { ...wake, streak: 3 } }],
    });
    expect(third).toContain(
      "the 3rd message in a row you were woken for without anyone saying your name",
    );
  });

  test("the streak survives the pending queue; a malformed one is refused", () => {
    const deep = { ...wake, streak: 2 };
    const back = entryToInbound(
      parsePendingLine(JSON.stringify(toPendingEntry({ ...msg(4), unnamedWake: deep })))!,
    );
    expect(back?.unnamedWake).toEqual(deep);
    for (const bad of [0, 1.5, "2"]) {
      const junk = parsePendingLine(
        JSON.stringify({ ...toPendingEntry(msg(4)), unnamedWake: { ...wake, streak: bad } }),
      );
      expect(junk?.unnamedWake).toBeUndefined();
    }
  });
});

describe("who else is in the chat", () => {
  const config = makeConfig("on");

  test("a message opening with another member's first name is flagged, never named", async () => {
    expect(opensWithOtherMember(msg(27), chatDb, contacts, config)).toBe(true);
    // Sam saying his own name, or a name later in the message, is not the pattern.
    expect(opensWithOtherMember(msg(28), chatDb, contacts, config)).toBe(false);
    expect(opensWithOtherMember(msg(29), chatDb, contacts, config)).toBe(false);
    expect(opensWithOtherMember(msg(27), chatDb, undefined, config)).toBe(false);

    const { f, calls } = jev(0.1, 0.1);
    const checker = new AddressChecker({ config: freshConfig(), chatDb, contacts, fetch: f });
    await checker.check(msg(27), "after-assistant");
    await checker.check(msg(29), "after-assistant");
    const sent = calls as { state: { latestMessage: Record<string, unknown> } }[];
    expect(sent[0]!.state.latestMessage.opensWithNameOf).toBe("someone else in this chat");
    expect(sent[1]!.state.latestMessage.opensWithNameOf).toBeUndefined();
    // Jev gets the fact, not the member list: no name the text doesn't hold.
    expect(JSON.stringify(sent)).not.toContain("Rivera");
    expect(JSON.stringify(sent)).not.toContain("Alex");
  });
});

describe("measured rates", () => {
  test("bands count only messages that pass the floor, smoothed so none claims certainty", () => {
    const rows = [
      { wantsReply: 0.75, addressed: 0.8, forHim: true },
      { wantsReply: 0.72, addressed: 0.6, forHim: false },
      { wantsReply: 0.78, addressed: 0.2, forHim: true },
      { wantsReply: 1, addressed: 0.9, forHim: true },
    ];
    const bands = rateBands(rows, 0.5);
    expect(bands[7]).toMatchObject({ n: 2, yes: 1, rate: 0.5 });
    expect(bands[9]).toMatchObject({ n: 1, yes: 1, rate: 2 / 3 });
  });

  test("a score takes its band's rate; Jev's own probability where nothing was measured", () => {
    const cal = { version: ADDRESS_QUESTIONS_VERSION, bands: [band(0.7, 25, 15), band(0.8, 0, 0)] };
    expect(measuredRate(0.75, cal)).toEqual({ value: 16 / 27, source: "measured" });
    expect(measuredRate(0.85, cal)).toEqual({ value: 0.85, source: "jev" });
    expect(measuredRate(0.85, null)).toEqual({ value: 0.85, source: "jev" });
  });

  test("a table measured on another wording is not used", () => {
    const d = mkdtempSync(join(dir, "cal-"));
    mkdirSync(join(d, "addressing"));
    const path = join(d, "addressing", `calibration-${ADDRESS_QUESTIONS_VERSION}.json`);
    writeFileSync(path, JSON.stringify({ version: "older", rates: [band(0.7, 25, 15)] }));
    expect(loadCalibration(d)).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({ version: ADDRESS_QUESTIONS_VERSION, rates: [band(0.7, 25, 15)] }),
    );
    expect(loadCalibration(d)?.bands).toHaveLength(1);
  });
});

describe("the un-named streak", () => {
  // 0.7-0.8 right about 59% of the time: each such wake costs ~0.41 of the 0.6 budget.
  const middling = [band(0.7, 25, 15)];
  // 0.9+ right 38 of 39: each costs ~0.03.
  const confident = [band(0.9, 37, 37)];

  test("it starts after the last message that named him or swipe-replied to him", () => {
    expect(lastEngagedRow(chatDb, RUN, 22, makeConfig("on"))).toBe(20);
    expect(lastEngagedRow(chatDb, RUN, 31, makeConfig("on"))).toBe(30);
    expect(lastEngagedRow(chatDb, RUN, 33, makeConfig("on"))).toBe(32);
    expect(lastEngagedRow(chatDb, CREW, 5, makeConfig("on"))).toBe(0);
    // A tapback on his message is not addressing him.
    expect(lastEngagedRow(chatDb, CREW, 8, makeConfig("on"))).toBe(5);
  });

  test("middling wakes stop once the expected misfires pass the budget; naming him resets it", async () => {
    const checker = new AddressChecker({
      config: freshConfig(middling),
      chatDb,
      fetch: jev(0.8, 0.75).f,
    });
    const first = await checker.check(msg(22), "after-assistant");
    expect(first.wake).toBe(true);
    expect(first.woken?.unnamedWake.streak).toBe(1);
    const second = await checker.check(msg(24), "after-assistant");
    expect(second).toMatchObject({ wake: false, overBudget: true });
    expect(second.streak?.count).toBe(1);
    expect((await checker.check(msg(26), "after-assistant")).overBudget).toBe(true);
    // Row 30 says his name: a fresh streak.
    const after = await checker.check(msg(31), "after-assistant");
    expect(after.wake).toBe(true);
    expect(after.streak).toEqual({ count: 0, expected: 0 });
  });

  test("a confident back-and-forth barely decays", async () => {
    const checker = new AddressChecker({
      config: freshConfig(confident),
      chatDb,
      fetch: jev(0.9, 0.95).f,
    });
    const streaks: (number | undefined)[] = [];
    for (const row of [22, 24, 26]) {
      const d = await checker.check(msg(row), "after-assistant");
      expect(d.wake).toBe(true);
      streaks.push(d.woken?.unnamedWake.streak);
    }
    expect(streaks).toEqual([1, 2, 3]);
  });

  test("without a measured table, Jev's own probability is the rate", async () => {
    const checker = new AddressChecker({ config: freshConfig(), chatDb, fetch: jev(0.8, 0.75).f });
    const a = await checker.check(msg(22), "after-assistant");
    expect(a.rate).toEqual({ value: 0.75, source: "jev" });
    expect(a.wake).toBe(true);
    expect((await checker.check(msg(24), "after-assistant")).wake).toBe(true);
    expect((await checker.check(msg(26), "after-assistant")).overBudget).toBe(true);
  });

  test("a restart loses nothing: the streak is read back from the decision log", async () => {
    const config = freshConfig(middling);
    await new AddressChecker({ config, chatDb, fetch: jev(0.8, 0.75).f }).check(
      msg(22),
      "after-assistant",
    );
    const restarted = new AddressChecker({ config, chatDb, fetch: jev(0.8, 0.75).f });
    expect((await restarted.check(msg(24), "after-assistant")).overBudget).toBe(true);
  });

  test("two messages at once are judged in order, so both cannot spend the same budget", async () => {
    // Jev answers the second message first, as a real one can.
    const { f } = jev(0.8, 0.75, 200, [40, 0]);
    const checker = new AddressChecker({ config: freshConfig(middling), chatDb, fetch: f });
    const [a, b] = await Promise.all([
      checker.check(msg(22), "after-assistant"),
      checker.check(msg(24), "after-assistant"),
    ]);
    expect(a.wake).toBe(true);
    expect(b.overBudget).toBe(true);
  });

  test("the budget is only for wakes soon after he spoke", async () => {
    const checker = new AddressChecker({
      config: freshConfig(middling),
      chatDb,
      fetch: jev(0.8, 0.75).f,
    });
    await checker.check(msg(22), "after-assistant");
    const swipe = await checker.check(msg(32), "reply-to-assistant");
    expect(swipe.wake).toBe(true);
    expect(swipe.streak).toBeUndefined();
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
