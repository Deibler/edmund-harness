import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactBook } from "../src/sessions/contacts.ts";
import {
  MIN_CHATS,
  MIN_OCCURRENCES,
  type Proposal,
  type SampledAsk,
  parseProposals,
  sampleRecentAsks,
  vetProposal,
} from "../src/skills/curator.ts";

/**
 * The curator's bar.
 *
 * The whole design premise is that MOST runs produce nothing, so these tests
 * are mostly about rejection. A curator that writes a skill whenever a model
 * feels like one would fill the catalogue with plausible entries, and the
 * catalogue is read in full by the model to decide what it can do.
 */

const contacts = new ContactBook([
  { name: "Sam", handles: ["+15550001111"] },
  { name: "Jordan", handles: ["+15550002222"] },
]);

const sample: SampledAsk[] = [
  { ref: "msg:a1", chat: "chatA", text: "how long should my long run be", ts: 1 },
  { ref: "msg:a2", chat: "chatA", text: "what pace for the tempo", ts: 2 },
  { ref: "msg:b1", chat: "chatB", text: "am i tapering right", ts: 3 },
  { ref: "msg:c1", chat: "chatC", text: "what should i eat before the race", ts: 4 },
];

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    name: "race-week-plan",
    description: "Build a taper and fuelling plan for the week before a race.",
    instructions: "Ask for the race distance and date. Then work backwards.",
    evidence: [
      { ref: "msg:a1", chat: "chatA", reading: "training volume" },
      { ref: "msg:b1", chat: "chatB", reading: "taper" },
      { ref: "msg:c1", chat: "chatC", reading: "fuelling" },
    ],
    whyNow: "three unrelated people asked inside two weeks",
    ...overrides,
  };
}

const base = { sample, existing: {}, existingNames: [] as string[], contacts };

describe("what the curator is allowed to write", () => {
  test("a real cross-chat pattern with real citations passes", () => {
    expect(vetProposal({ proposal: proposal(), ...base }).ok).toBe(true);
  });

  test("invented citations are rejected — a model asked for refs will supply refs", () => {
    const result = vetProposal({
      proposal: proposal({
        evidence: [
          { ref: "msg:zzz1", chat: "chatA", reading: "made up" },
          { ref: "msg:zzz2", chat: "chatB", reading: "made up" },
          { ref: "msg:zzz3", chat: "chatC", reading: "made up" },
        ],
      }),
      ...base,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("exist in the sample");
  });

  test("one person's habit is rejected however many times they asked", () => {
    // Three real refs, all from one conversation. This is exactly what
    // create_skill already covers, and calling it a cross-conversation
    // pattern would be the curator's most likely failure mode: the busiest
    // chat supplies most of the corpus.
    const result = vetProposal({
      proposal: proposal({
        evidence: [
          { ref: "msg:a1", chat: "chatA", reading: "one" },
          { ref: "msg:a2", chat: "chatA", reading: "two" },
          { ref: "msg:a1", chat: "chatA", reading: "again" },
        ],
      }),
      ...base,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("one person's habit");
  });

  test("too few sightings is rejected", () => {
    const result = vetProposal({
      proposal: proposal({
        evidence: [
          { ref: "msg:a1", chat: "chatA", reading: "one" },
          { ref: "msg:b1", chat: "chatB", reading: "two" },
        ],
      }),
      ...base,
    });
    expect(result.ok).toBe(false);
  });

  test("a skill carrying someone's name never ships", () => {
    const result = vetProposal({
      proposal: proposal({
        instructions: "Ask the race distance. Sam prefers a three-week taper.",
      }),
      ...base,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("personal detail");
  });

  test("a skill carrying a phone number or address never ships", () => {
    for (const leak of ["call 717-555-0134 to confirm", "meet at 910 N 27th St"]) {
      const result = vetProposal({
        proposal: proposal({ instructions: `Do the thing. ${leak}` }),
        ...base,
      });
      expect(result.ok).toBe(false);
    }
  });

  test("a name already in the catalogue is rejected", () => {
    const result = vetProposal({
      ...base,
      proposal: proposal(),
      existingNames: ["race-week-plan"],
    });
    expect(result.ok).toBe(false);
  });

  test("a name already RETIRED is rejected — a retirement has to stick", () => {
    // The curator mines the same corpus every pass. Without this, a pattern
    // that produced a useless skill in March produces it again in April.
    const result = vetProposal({
      ...base,
      proposal: proposal(),
      retiredNames: ["race-week-plan"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("retired before");
  });

  test("the thresholds are the ones the prompt promises", () => {
    // The prompt tells the model the bar in prose; this pins the code to the
    // same numbers, so tuning one without the other is a test failure rather
    // than a silent disagreement.
    expect(MIN_OCCURRENCES).toBe(3);
    expect(MIN_CHATS).toBe(2);
  });
});

describe("reading the model's answer", () => {
  test("plain JSON, fenced JSON, and JSON with chatter all parse", () => {
    const body = `{"skills":[{"name":"a-b","description":"d","instructions":"i","evidence":[{"ref":"msg:a1","chat":"chatA","reading":"r"}]}],"notes":"n"}`;
    for (const raw of [
      body,
      `\`\`\`json\n${body}\n\`\`\``,
      `Here you go:\n${body}\nhope that helps`,
    ]) {
      const { proposals } = parseProposals(raw);
      expect(proposals.length).toBe(1);
      expect(proposals[0]?.name).toBe("a-b");
    }
  });

  test("an empty result is a normal outcome, not an error", () => {
    expect(parseProposals(`{"skills":[],"notes":"nothing recurred"}`).proposals).toEqual([]);
    expect(parseProposals(`{"skills":[],"notes":"nothing recurred"}`).notes).toBe(
      "nothing recurred",
    );
  });

  test("garbage and half-written entries yield nothing rather than throwing", () => {
    expect(parseProposals(null).proposals).toEqual([]);
    expect(parseProposals("I could not find a pattern.").proposals).toEqual([]);
    expect(parseProposals(`{"skills":[{"name":"x"}]}`).proposals).toEqual([]);
  });
});

describe("sampling across conversations", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "curator-"));
    dbPath = join(dir, "recall.sqlite");
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE rows (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_guid TEXT, sender TEXT,
                          ts INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB, model TEXT, dim INTEGER)`,
    );
    const insert = db.query(
      "INSERT INTO rows (ref, kind, chat_guid, sender, ts, text, vec, model, dim) VALUES (?,?,?,?,?,?,x'00','m',1)",
    );
    // One loud chat with 200 messages, two quiet ones with 5 each. This is the
    // real shape of the corpus: a single conversation supplies most of it.
    for (let i = 0; i < 200; i++) {
      insert.run(
        `msg:loud${i}`,
        "message",
        "chatLOUD",
        "+1555",
        1000 + i,
        `[2026-08-29] +1555: a fairly long question number ${i}`,
      );
    }
    for (const chat of ["chatQ1", "chatQ2"]) {
      for (let i = 0; i < 5; i++) {
        insert.run(
          `msg:${chat}-${i}`,
          "message",
          chat,
          "+1666",
          1000 + i,
          `[2026-08-29] +1666: a fairly long question number ${i}`,
        );
      }
    }
    // Edmund's own replies, which must never be sampled: training the
    // catalogue on his own output turns a habit into a documented procedure.
    for (let i = 0; i < 20; i++) {
      insert.run(
        `msg:me${i}`,
        "message",
        "chatLOUD",
        "me",
        1000 + i,
        `[2026-08-29] me: here is my long answer ${i}`,
      );
    }
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("no chat can supply more than its cap, so a loud room cannot be the pattern", () => {
    const asks = sampleRecentAsks(dbPath, { sinceMs: 0 });
    const perChat = new Map<string, number>();
    for (const a of asks) perChat.set(a.chat, (perChat.get(a.chat) ?? 0) + 1);
    expect(perChat.get("chatLOUD")).toBeLessThanOrEqual(40);
    // The quiet rooms are all present despite being outnumbered 40 to 1.
    expect(perChat.get("chatQ1")).toBe(5);
    expect(perChat.get("chatQ2")).toBe(5);
  });

  test("Edmund's own messages are never sampled", () => {
    const asks = sampleRecentAsks(dbPath, { sinceMs: 0 });
    expect(asks.some((a) => a.text.includes("here is my long answer"))).toBe(false);
  });

  test("the sender prefix is stripped before the text can reach a prompt", () => {
    const asks = sampleRecentAsks(dbPath, { sinceMs: 0 });
    expect(asks.length).toBeGreaterThan(0);
    for (const a of asks) {
      expect(a.text).not.toContain("+1555");
      expect(a.text).not.toMatch(/^\[\d{4}-\d{2}-\d{2}\]/);
    }
  });

  test("the lookback window is honoured", () => {
    expect(sampleRecentAsks(dbPath, { sinceMs: 999_999 })).toEqual([]);
  });
});
