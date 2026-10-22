/**
 * The offer of a kitchen, and the first week after somebody takes it.
 *
 * The offer used to come back as an error gated on "the second or third time"
 * somebody asked, and was made twice in about 30 food questions. These pin
 * what replaced it: a chat with no kitchen gets a normal answer that says to
 * answer first and offer now; an offer is made at most twice and a no is
 * final; an offer that never reached the chat (checked in chat.db) does not
 * count; a big group is never offered one; and setup queues three check-ins
 * that decide from the ledger whether they are still needed.
 *
 * Runs against a scratch KITCHEN_DIR and a scratch chat.db.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-offer-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants"), { recursive: true });
writeFileSync(join(BASE, "tenants.json"), JSON.stringify({ version: 1, tenants: {} }));

const { kitchenTools } = await import("../tools.ts");
const { AGAIN_AFTER_MS, consider, decide, decline, forget, prospect } = await import(
  "../src/prospects.ts"
);
const { CHECKIN_GRACE_MS, PITCH, checkinBrief, offerBrief, provision, scheduleCheckins } =
  await import("../src/onboard.ts");
const { createAccount, getAccount, updateAccount } = await import("../src/accounts.ts");
const { append } = await import("../src/store.ts");
const { ChatDb } = await import("../../../src/imessage/db.ts");
import type { JobInput } from "../../../src/cron/types.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-20T16:00:00Z");

/* ── a scratch chat.db ───────────────────────────────────────────────────── */

const DB = join(BASE, "chat.db");
{
  const db = new Database(DB, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, display_name TEXT);
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
      is_from_me INTEGER, date INTEGER, associated_message_type INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  db.close();
}
const write = (sql: string, ...args: (string | number)[]) => {
  const db = new Database(DB);
  db.query(sql).run(...args);
  db.close();
};
const ns = (ms: number) => (ms - ChatDb.APPLE_EPOCH_MS) * ChatDb.NS_PER_MS;
let chatRow = 0;
let msgRow = 0;
function chat(guid: string, handles: string[]): number {
  const id = ++chatRow;
  write(
    "INSERT INTO chat (ROWID, guid, style) VALUES (?, ?, ?)",
    id,
    guid,
    handles.length > 1 ? 43 : 45,
  );
  for (const h of handles) {
    write("INSERT INTO handle (id) VALUES (?)", h);
    write(
      "INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, (SELECT MAX(ROWID) FROM handle))",
      id,
    );
  }
  return id;
}
function sent(chatId: number, at: number, body: string): void {
  const id = ++msgRow;
  write(
    "INSERT INTO message (ROWID, guid, text, is_from_me, date) VALUES (?, ?, ?, 1, ?)",
    id,
    `m${id}`,
    body,
    ns(at),
  );
  write("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", chatId, id);
}

/* ── the tool, as a session sees it ──────────────────────────────────────── */

const NAMES: Record<string, string> = {
  "+15550000011": "Sam Rivera",
  "+15550000012": "Alex Rivera",
  "+15550000013": "Jordan Lee",
  "+15550000014": "Morgan Park",
};
type Job = JobInput & { id: string };

function session(key: string, guids: string[], jobs: Job[] = []) {
  const tools = kitchenTools({
    sessionKey: key,
    chatGuids: guids,
    chatDb: new ChatDb(DB),
    contacts: { displayName: (h: string) => NAMES[h] ?? null },
    cron: {
      create: (input: JobInput) => {
        const job = { ...input, id: `job${jobs.length + 1}` };
        jobs.push(job);
        return job;
      },
    },
    config: { kitchen: { enabled: true, dir: BASE }, paths: { data_dir: BASE } },
  } as never);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name)!;
    const res = (await tool.handler(args as never)) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { text: res.content[0]!.text, isError: Boolean(res.isError) };
  };
}

/* ── when to offer ───────────────────────────────────────────────────────── */

describe("when to offer", () => {
  const P = "imessage:dm:+15550000001";

  test("the first food question gets the offer, and it is recorded", () => {
    const { decision, prospect: p } = consider(P, { now: T0 });
    expect(decision).toEqual({ kind: "offer", again: false });
    expect(p.offers).toHaveLength(1);
    expect(p.asks).toHaveLength(1);
  });
  test("a second call in the same turn still says offer, without recording it twice", () => {
    const { decision, prospect: p } = consider(P, { now: T0 + 5 * 60_000 });
    expect(decision.kind).toBe("offer");
    expect(p.offers).toHaveLength(1);
    expect(p.asks).toHaveLength(1);
  });
  test("two days later the offer is waiting on an answer, not repeated", () => {
    const { decision, prospect: p } = consider(P, { now: T0 + 2 * DAY });
    expect(decision.kind).toBe("wait");
    expect(p.offers).toHaveLength(1);
    expect(p.asks).toHaveLength(2);
  });
  test("a week unanswered, it is made once more", () => {
    const { decision, prospect: p } = consider(P, { now: T0 + 2 * DAY + AGAIN_AFTER_MS });
    expect(decision).toEqual({ kind: "offer", again: true });
    expect(p.offers).toHaveLength(2);
  });
  test("and after a second unanswered week it stops for good", () => {
    const { decision } = consider(P, { now: T0 + 2 * DAY + 3 * AGAIN_AFTER_MS });
    expect(decision.kind).toBe("stop");
    expect(decision.kind === "stop" && decision.why).toBe("unanswered");
  });
  test("a no is final, however long ago it was offered", () => {
    const Q = "imessage:dm:+15550000002";
    consider(Q, { now: T0 });
    decline(Q, T0 + 60_000);
    expect(consider(Q, { now: T0 + 90 * DAY }).decision.kind).toBe("stop");
  });
  test("an offer that never reached the chat does not count", () => {
    const Q = "imessage:dm:+15550000003";
    consider(Q, { now: T0 });
    const later = consider(Q, { now: T0 + DAY, delivered: () => false });
    expect(later.decision).toEqual({ kind: "offer", again: false });
    expect(later.prospect.offers).toHaveLength(1);
  });
  test("one that cannot be checked is kept", () => {
    const Q = "imessage:dm:+15550000004";
    consider(Q, { now: T0 });
    expect(consider(Q, { now: T0 + DAY, delivered: () => null }).decision.kind).toBe("wait");
  });
  test("an offer being made right now is never checked for delivery", () => {
    const Q = "imessage:dm:+15550000005";
    consider(Q, { now: T0 });
    const same = consider(Q, { now: T0 + 60_000, delivered: () => false });
    expect(same.prospect.offers).toHaveLength(1);
  });
  test("decide is pure: an empty record offers", () => {
    expect(decide({ asks: [], offers: [] })).toEqual({ kind: "offer", again: false });
  });
  test("forget clears somebody who now has a kitchen", () => {
    forget(P);
    expect(prospect(P).offers).toHaveLength(0);
  });
});

/* ── what the model is told ──────────────────────────────────────────────── */

describe("the brief", () => {
  const offer = offerBrief({}, { kind: "offer", again: false });

  test("answer first, then offer, with the whole pitch", () => {
    expect(offer).toContain("Answer what they asked in full");
    expect(offer).toContain("Never hold an answer back");
    expect(offer).toContain("in the same message as your answer");
    expect(offer).toContain(PITCH);
  });
  test("it names the moves for a yes and a no", () => {
    expect(offer).toContain('kitchen_onboard action:"start"');
    expect(offer).toContain('kitchen_onboard action:"decline"');
  });
  test("it no longer waits for a repeat asker", () => {
    expect(offer).not.toMatch(/second or third|more than once/);
  });
  test("waiting and stopped never carry the pitch", () => {
    const since = new Date(T0).toISOString();
    for (const d of [
      { kind: "wait" as const, since },
      { kind: "stop" as const, why: "declined" as const, since },
    ]) {
      const b = offerBrief({}, d);
      expect(b).toContain("Answer what they asked in full");
      expect(b).not.toContain(PITCH);
    }
  });
  test("a group bigger than three is never offered one", () => {
    const b = offerBrief({ group: ["A", "B", "C", "D"] }, { kind: "offer", again: false });
    expect(b).not.toContain(PITCH);
    expect(b).toContain("Do not offer one here");
  });
  test("a small group is offered only on judgement, and a housed member points to joining", () => {
    const b = offerBrief(
      { group: ["Sam", "Alex"], housed: [{ name: "Sam", account: "rivera" }] },
      { kind: "offer", again: false },
    );
    expect(b).toContain("Sam and Alex");
    expect(b).toContain("plausibly share one kitchen");
    expect(b).toContain('kitchen_accounts action:"join" account:"rivera"');
  });
});

/* ── through the tools ───────────────────────────────────────────────────── */

describe("a chat with no kitchen, through the tools", () => {
  test("kitchen_status is an answer, not an error, and carries the offer", async () => {
    const call = session("imessage:dm:+15550000021", []);
    const res = await call("kitchen_status");
    expect(res.isError).toBe(false);
    expect(res.text).toContain(PITCH);
  });
  test("so is any other kitchen tool", async () => {
    const call = session("imessage:dm:+15550000022", []);
    const res = await call("kitchen_list");
    expect(res.isError).toBe(false);
    expect(res.text).toContain("No kitchen is set up for this chat");
  });
  test("after a decline, kitchen_status stops offering", async () => {
    const call = session("imessage:dm:+15550000023", []);
    await call("kitchen_status");
    await call("kitchen_onboard", { action: "decline" });
    const res = await call("kitchen_status");
    expect(res.text).not.toContain(PITCH);
    expect(res.text).toContain("Do not bring it up again");
  });
  test("an earlier offer that chat.db shows was never sent is made again", async () => {
    const key = "imessage:dm:+15550000024";
    const id = chat("chat-24", ["+15550000024"]);
    const at = Date.now() - 30 * 60_000;
    consider(key, { now: at });
    sent(
      id,
      at + 60_000,
      "350 for an hour, then rest it ten minutes. Leftovers keep in the fridge.",
    );
    const res = await session(key, ["chat-24"])("kitchen_status");
    expect(res.text).toContain(PITCH);
  });
  test("one chat.db shows was sent is waited on", async () => {
    const key = "imessage:dm:+15550000025";
    const id = chat("chat-25", ["+15550000025"]);
    const at = Date.now() - 30 * 60_000;
    consider(key, { now: at });
    sent(id, at + 60_000, "Want me to keep track of your kitchen? Two photos and you're set.");
    const res = await session(key, ["chat-25"])("kitchen_status");
    expect(res.text).not.toContain(PITCH);
    expect(res.text).toContain("You offered them a kitchen");
  });
  test("a big group gets no offer and records nothing", async () => {
    const key = "imessage:group:any;+;big";
    chat("any;+;big", ["+15550000011", "+15550000012", "+15550000013", "+15550000014"]);
    const res = await session(key, ["any;+;big"])("kitchen_status");
    expect(res.text).not.toContain(PITCH);
    expect(prospect(key).asks).toHaveLength(0);
  });
  test("a small group is named by first name, for the model to judge", async () => {
    chat("any;+;pair", ["+15550000011", "+15550000012"]);
    const res = await session("imessage:group:any;+;pair", ["any;+;pair"])("kitchen_status");
    expect(res.text).toContain("Sam and Alex");
    expect(res.text).toContain(PITCH);
  });
});

/* ── setting it up ───────────────────────────────────────────────────────── */

describe("start", () => {
  test("in a small group, it links everyone in it who has no kitchen of their own", async () => {
    createAccount("lee", { members: ["imessage:dm:+15550000013"] });
    chat("any;+;three", ["+15550000011", "+15550000012", "+15550000013"]);
    const jobs: Job[] = [];
    const key = "imessage:group:any;+;three";
    const call = session(key, ["any;+;three"], jobs);
    await call("kitchen_status");
    const res = await call("kitchen_onboard", { action: "start", id: "rivera" });
    expect(res.isError).toBe(false);
    const acct = getAccount("rivera")!;
    expect(acct.members).toContain(key);
    expect(acct.members).toContain("imessage:dm:+15550000011");
    expect(acct.members).toContain("imessage:dm:+15550000012");
    expect(acct.members).not.toContain("imessage:dm:+15550000013");
    expect(acct.people?.["imessage:dm:+15550000011"]).toBe("Sam");
    expect(acct.onboarded?.via).toBe(key);
    expect(prospect(key).asks).toHaveLength(0);
    expect(jobs.map((j) => j.sessionKey)).toEqual([key, key, key]);
    expect(res.text).toContain("Sam and Alex");
  });
  test("updating an existing household queues nothing", async () => {
    const jobs: Job[] = [];
    const call = session("imessage:group:any;+;three", ["any;+;three"], jobs);
    const res = await call("kitchen_onboard", { action: "start", id: "rivera", budget: 120 });
    expect(res.text).toContain('Updated "rivera"');
    expect(jobs).toHaveLength(0);
  });
});

/* ── the first week ──────────────────────────────────────────────────────── */

describe("check-ins", () => {
  const VIA = "imessage:dm:+15550000031";
  provision("park", { principal: VIA, person: "Morgan" });

  test("three, in local time, days 1, 4 and 7, skipped if hours late", () => {
    const jobs: Job[] = [];
    const from = new Date(2026, 9, 20, 13, 5);
    const out = scheduleCheckins(
      "park",
      VIA,
      (j) => {
        jobs.push({ ...j, id: "x" });
        return { id: "x" };
      },
      from,
    );
    const at = out.map((o) => new Date(o.atMs));
    expect(out.map((o) => o.kind)).toEqual(["dinner", "receipt", "recap"]);
    expect(at.map((d) => d.getDate())).toEqual([21, 24, 27]);
    expect(at.map((d) => `${d.getHours()}:${d.getMinutes()}`)).toEqual(["16:0", "17:30", "16:0"]);
    expect(jobs.every((j) => j.gracePeriodMs === CHECKIN_GRACE_MS)).toBe(true);
    expect(jobs.every((j) => j.systemEvent.includes('kitchen_onboard action:"checkin"'))).toBe(
      true,
    );
  });
  test("day 1 asks for a dinner from their shelves until they have cooked", () => {
    expect(checkinBrief("park", "dinner")).toContain("kitchen_plan");
    append("park", [{ op: "use", item: "eggs", src: "cooked", why: "omelette" }]);
    expect(checkinBrief("park", "dinner")).toContain("Nothing to send");
  });
  test("an undone receipt is not a receipt", () => {
    provision("ash", { principal: "imessage:dm:+15550000033" });
    const batch = append("ash", [{ op: "add", item: "milk", src: "receipt:giant-2026-10-22" }]);
    append("ash", [{ op: "undo", batch_target: batch }]);
    expect(checkinBrief("ash", "receipt")).toContain("receipt keeps the kitchen current");
  });
  test("day 4 nudges for a receipt until one comes in", () => {
    expect(checkinBrief("park", "receipt")).toContain("receipt keeps the kitchen current");
    append("park", [{ op: "add", item: "milk", src: "receipt:giant-2026-10-22" }]);
    expect(checkinBrief("park", "receipt")).toContain("Nothing to send");
  });
  test("day 7 recaps from the ledger and offers dinner texts once", () => {
    const b = checkinBrief("park", "recap");
    expect(b).toContain("1 receipt and 1 meal");
    expect(b).toContain("kitchen_schedule");
    updateAccount("park", { dinners: [{ at: "16:00" } as never] });
    expect(checkinBrief("park", "recap")).not.toContain("kitchen_schedule");
  });
  test("a chat with no kitchen any more ends quietly", () => {
    expect(checkinBrief(null, "recap")).toContain("Nothing to send");
  });
});
