import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCLUDED_CATEGORIES,
  type IdeatorOutput,
  parseIdeatorOutput,
  personExcerpt,
  pickCandidate,
} from "../src/ideation/ideator.ts";
import { ChatDb } from "../src/imessage/db.ts";

const DM = "any;-;+15550100001";
const NOW = Date.parse("2026-11-03T12:00:00-05:00");
const DAY = 86_400_000;
const appleNs = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

const dir = mkdtempSync(join(tmpdir(), "ideation-pick-"));
const dbPath = join(dir, "chat.db");
{
  const w = new Database(dbPath);
  w.exec("PRAGMA journal_mode = WAL");
  w.exec(`
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
      is_from_me INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
      handle_id INTEGER DEFAULT 0);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat VALUES (1, '${DM}', '+15550100001', 45);
  `);
  const add = (row: number, at: number, me = false) => {
    w.query(
      "INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES (?, ?, 'q', ?, ?, 1)",
    ).run(row, `g${row}`, appleNs(at), me ? 1 : 0);
    w.query("INSERT INTO chat_message_join VALUES (1, ?)").run(row);
  };
  add(1, NOW - 1 * DAY);
  add(2, NOW - 3 * DAY);
  add(3, NOW - 5 * DAY);
  add(4, NOW - 2 * DAY);
  add(5, NOW - 6 * DAY, true); // Edmund
  add(11, NOW - 1 * DAY); // a second recurring thread
  add(12, NOW - 4 * DAY);
  add(13, NOW - 9 * DAY);
  w.close();
}
const chatDb = new ChatDb(dbPath);
const ctx = (lastBuiltMs: (k: string) => number | null = () => null) => ({
  chatDb,
  chatGuids: [DM],
  nowMs: NOW,
  lastBuiltMs,
});
const candidate = (thread: string, title = `Page for ${thread}`) => ({
  thread,
  title,
  pitch: "An interactive page about it.",
  why: "They asked on three separate days.",
  brief: "Build an interactive explorer with sections for each question they asked. ".repeat(2),
});

describe("pickCandidate", () => {
  test("picks the first candidate whose thread recurs", () => {
    const out: IdeatorOutput = {
      threads: [{ label: "The night sky", category: "interest", evidence: [1, 2, 3, 5] }],
      candidates: [candidate("the night sky!")],
      reason: "",
    };
    const r = pickCandidate(out, ctx());
    expect(r.pick?.thread).toBe("The night sky");
    expect(r.pick?.days).toHaveLength(3);
    // Edmund's own row is never carried as evidence.
    expect(r.pick?.evidence).toEqual([1, 2, 3]);
  });

  test("a sensitive thread is never built, however often it recurs", () => {
    const out: IdeatorOutput = {
      threads: [
        { label: "back pain", category: "health", evidence: [1, 2, 3] },
        { label: "fishing", category: "interest", evidence: [11, 12, 13] },
      ],
      candidates: [candidate("back pain"), candidate("fishing")],
      reason: "",
    };
    const r = pickCandidate(out, ctx());
    expect(r.pick?.thread).toBe("fishing");
    expect(r.turnedDown[0]?.why).toContain("health");
  });

  test("every sensitive category is excluded", () => {
    for (const c of ["health", "legal", "grief", "relationship", "money"] as const) {
      expect(EXCLUDED_CATEGORIES.has(c)).toBe(true);
      const out: IdeatorOutput = {
        threads: [{ label: "x thread", category: c, evidence: [1, 2, 3] }],
        candidates: [candidate("x thread")],
        reason: "",
      };
      expect(pickCandidate(out, ctx()).pick).toBeNull();
    }
  });

  test("a thread on two days is turned down even when the model ranks it first", () => {
    const out: IdeatorOutput = {
      threads: [
        { label: "road trip", category: "project", evidence: [1, 4] },
        { label: "fishing", category: "interest", evidence: [11, 12, 13] },
      ],
      candidates: [candidate("road trip"), candidate("fishing")],
      reason: "",
    };
    const r = pickCandidate(out, ctx());
    expect(r.pick?.thread).toBe("fishing");
    expect(r.turnedDown).toEqual([
      {
        title: "Page for road trip",
        thread: "road trip",
        why: "their messages span 2 day(s), fewer than 3",
      },
    ]);
  });

  test("a candidate whose thread was never listed is turned down", () => {
    const out: IdeatorOutput = {
      threads: [{ label: "fishing", category: "interest", evidence: [11, 12, 13] }],
      candidates: [candidate("astronomy")],
      reason: "",
    };
    const r = pickCandidate(out, ctx());
    expect(r.pick).toBeNull();
    expect(r.turnedDown[0]?.why).toContain("not among the threads");
  });

  test("a thread built three weeks ago or less waits; older may be built again", () => {
    const out: IdeatorOutput = {
      threads: [{ label: "fishing", category: "interest", evidence: [11, 12, 13] }],
      candidates: [candidate("fishing")],
      reason: "",
    };
    expect(
      pickCandidate(
        out,
        ctx(() => NOW - 10 * DAY),
      ).pick,
    ).toBeNull();
    expect(
      pickCandidate(
        out,
        ctx(() => NOW - 22 * DAY),
      ).pick?.thread,
    ).toBe("fishing");
  });

  test("evidence the model invented does not count", () => {
    const out: IdeatorOutput = {
      threads: [{ label: "fishing", category: "interest", evidence: [11, 12, 999, 998] }],
      candidates: [candidate("fishing")],
      reason: "",
    };
    expect(pickCandidate(out, ctx()).pick).toBeNull();
  });
});

describe("parseIdeatorOutput", () => {
  const good = {
    threads: [{ label: "fishing", category: "interest", evidence: [1] }],
    candidates: [],
    reason: "nothing yet",
  };

  test("reads JSON even with prose around it", () => {
    expect(parseIdeatorOutput(`Here it is:\n${JSON.stringify(good)}\nDone.`)?.reason).toBe(
      "nothing yet",
    );
  });

  test("rejects an unknown category instead of guessing", () => {
    const bad = { ...good, threads: [{ label: "fishing", category: "hobby", evidence: [1] }] };
    expect(parseIdeatorOutput(JSON.stringify(bad))).toBeNull();
  });

  test("rejects a candidate without a usable brief", () => {
    const bad = { ...good, candidates: [{ ...candidate("fishing"), brief: "make a page" }] };
    expect(parseIdeatorOutput(JSON.stringify(bad))).toBeNull();
  });

  test("rejects non-JSON", () => {
    expect(parseIdeatorOutput("I could not decide.")).toBeNull();
  });
});

describe("personExcerpt", () => {
  test("keeps who they are and their rules, drops the rest", () => {
    const body = [
      "# Someone",
      "## Operating Principles",
      "- rule one",
      "## Our Dynamic",
      "- private dynamic",
      "## Who They Are",
      "- fishes",
      "## Open Items",
      "- an open item",
    ].join("\n");
    const ex = personExcerpt(body);
    expect(ex).toContain("rule one");
    expect(ex).toContain("fishes");
    expect(ex).not.toContain("private dynamic");
    expect(ex).not.toContain("an open item");
  });
});
