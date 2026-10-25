import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASK_AFTER_IGNORED,
  type FireReception,
  fireReceptions,
  receptionBlock,
  trailingIgnored,
} from "../src/cron/reception.ts";
import { CronStore } from "../src/cron/store.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const { path, cleanup } = emptyChatDb();
const storeDir = mkdtempSync(join(tmpdir(), "cron-reception-"));
afterAll(() => {
  cleanup();
  rmSync(storeDir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 15, 16, 0);
const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;
{
  const db = new Database(path);
  db.exec(`INSERT INTO chat (ROWID, guid) VALUES (1, 'any;-;+15555550101')`);
  let id = 0;
  const add = (fromMe: number, ms: number, text: string) => {
    id++;
    db.query(
      "INSERT INTO message (ROWID, guid, text, is_from_me, date) VALUES (?, ?, ?, ?, ?)",
    ).run(id, `g${id}`, text, fromMe, appleNs(ms));
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)").run(id);
  };
  // Day 0: sent, replied. Days 1-3: sent, ignored.
  add(1, t0 + 30_000, "Apprentice electrician opening at Acme, posted today");
  add(0, t0 + 3_600_000, "ooh thanks");
  for (let d = 1; d <= 3; d++) add(1, t0 + d * DAY + 30_000, `Sales job ${d}`);
  db.close();
}
const chatDb = new ChatDb(path);
const windows = [0, 1, 2, 3].map((d) => ({
  startedMs: t0 + d * DAY,
  endedMs: t0 + d * DAY + 20_000,
}));

describe("a recurring job sees how its last sends landed", () => {
  test("each fire's sends and whether anyone answered come from chat.db", () => {
    const r = fireReceptions(chatDb, "any;-;+15555550101", windows, t0 + 4 * DAY);
    expect(r.map((x) => x.sends.length)).toEqual([1, 1, 1, 1]);
    expect(r.map((x) => x.replied)).toEqual([true, false, false, false]);
    expect(trailingIgnored(r)).toBe(3);
  });

  test("three ignored sends in a row: ask once instead of sending another", () => {
    const block = receptionBlock(
      fireReceptions(chatDb, "any;-;+15555550101", windows, t0 + 4 * DAY),
    );
    expect(block).toContain("Sales job 3");
    expect(block).toContain("no reply");
    expect(block).toContain("ask once");
    expect(block).not.toContain("KEEP_QUIET");
  });

  test("ignored after asking too: stay quiet and pause", () => {
    const quiet = (n: number): FireReception[] =>
      Array.from({ length: n }, (_, i) => ({
        startedMs: t0 + i * DAY,
        sends: [`s${i}`],
        replied: false,
      }));
    expect(receptionBlock(quiet(ASK_AFTER_IGNORED + 1))).toContain("KEEP_QUIET");
    expect(receptionBlock(quiet(2))).not.toContain("ask once");
  });

  test("a job with no history adds nothing", () => {
    expect(receptionBlock([])).toBeNull();
    expect(receptionBlock([{ startedMs: t0, sends: [], replied: false }])).toBeNull();
  });

  test("the store keeps fire windows, newest last", () => {
    const store = new CronStore(storeDir);
    try {
      store.recordFireWindow("job1", "dm:+15555550101", t0, t0 + 1000);
      store.recordFireWindow("job1", "dm:+15555550101", t0 + DAY, t0 + DAY + 1000);
      store.recordFireWindow("job2", "dm:+15555550101", t0, t0 + 1000);
      expect(store.recentFireWindows("job1", 6).map((w) => w.startedMs)).toEqual([t0, t0 + DAY]);
      expect(store.recentFireWindows("job1", 1).map((w) => w.startedMs)).toEqual([t0 + DAY]);
    } finally {
      store.close();
    }
  });

  test("recurring scheduled fires carry the block and record their window", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/cron/fire.ts"), "utf8");
    expect(src).toContain(
      'const recurring = job.schedule.kind !== "once" && kind === "scheduled";',
    );
    expect(src).toContain('...(reception ? ["", reception] : []),');
    expect(src).toContain("crons.recordFireWindow(job.id, job.sessionKey, started, Date.now());");
  });
});
