import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { AddressBook } from "../src/sessions/address-book.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import {
  MIN_CHATS,
  MIN_OCCURRENCES,
  MIN_PEOPLE,
  type Proposal,
  type SampledAsk,
  chatMembers,
  chatTag,
  hasUnrelatedPair,
  parseProposals,
  personKey,
  runCurator,
  sampleRecentAsks,
  vetProposal,
} from "../src/skills/curator.ts";
import { type InstallRecord, writeDb } from "../src/skills/installer.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

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
  {
    ref: "msg:a1",
    chat: "chatA",
    sender: "+15550001111",
    text: "how long should my long run be",
    ts: 1,
  },
  { ref: "msg:a2", chat: "chatA", sender: "+15550001111", text: "what pace for the tempo", ts: 2 },
  { ref: "msg:b1", chat: "chatB", sender: "+15550002222", text: "am i tapering right", ts: 3 },
  {
    ref: "msg:c1",
    chat: "chatC",
    sender: "+15550003333",
    text: "what should i eat before the race",
    ts: 4,
  },
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

  test("one person asking in several chats is still one person", () => {
    // 2026-10-16: seven asks across five chats (a DM and four groups), every
    // one from the same person, became a global skill.
    const spread: SampledAsk[] = ["chatA", "chatB", "chatC"].map((chat, i) => ({
      ref: `msg:s${i}`,
      chat,
      sender: "+15550001111",
      text: "make the next explainer video",
      ts: i,
    }));
    const result = vetProposal({
      ...base,
      sample: spread,
      proposal: proposal({
        evidence: spread.map((a) => ({ ref: a.ref, chat: a.chat, reading: "video" })),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("one person's habit");
  });

  test("two people in one room are one room", () => {
    // Two members of one family group asking for the family's own project.
    const room: SampledAsk[] = [
      { ref: "msg:r1", chat: "chatFAM", sender: "+15550001111", text: "next video", ts: 1 },
      { ref: "msg:r2", chat: "chatFAM", sender: "+15550002222", text: "next video", ts: 2 },
      { ref: "msg:r3", chat: "chatFAM", sender: "+15550001111", text: "next video", ts: 3 },
    ];
    const result = vetProposal({
      ...base,
      sample: room,
      proposal: proposal({
        evidence: room.map((a) => ({ ref: a.ref, chat: a.chat, reading: "video" })),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("one room's habit");
  });

  test("one family is one circle, even across a group and a DM", () => {
    // Two members of a family group ask there, and one of them asks in their
    // own DM too: two people in two chats, and still one family.
    const family: SampledAsk[] = [
      { ref: "msg:g1", chat: "chatFAM", sender: "+15550001111", text: "next video", ts: 1 },
      { ref: "msg:g2", chat: "chatFAM", sender: "+15550002222", text: "next video", ts: 2 },
      { ref: "msg:d1", chat: "dmA", sender: "+15550001111", text: "next video", ts: 3 },
    ];
    const result = vetProposal({
      ...base,
      sample: family,
      proposal: proposal({
        evidence: family.map((a) => ({ ref: a.ref, chat: a.chat, reading: "video" })),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("one circle's habit");
  });

  test("a silent member of the group is still in the room", () => {
    // A asks in the family group and in a DM; B never speaks in the group
    // but is in it, and asks in their own DM.
    const asks: SampledAsk[] = [
      { ref: "msg:s1", chat: "chatFAM", sender: "+15550001111", text: "next video", ts: 1 },
      { ref: "msg:s2", chat: "dmA", sender: "+15550001111", text: "next video", ts: 2 },
      { ref: "msg:s3", chat: "dmB", sender: "+15550002222", text: "next video", ts: 3 },
    ];
    const args = {
      ...base,
      sample: asks,
      proposal: proposal({
        evidence: asks.map((a) => ({ ref: a.ref, chat: a.chat, reading: "video" })),
      }),
    };
    const members = (chat: string) => (chat === "chatFAM" ? ["+15550001111", "+15550002222"] : []);
    expect(vetProposal({ ...args, membersOf: members }).ok).toBe(false);
    // Without chat.db the silent member cannot be seen: the residual.
    expect(vetProposal(args).ok).toBe(true);
  });

  test("two strangers in their own DMs are a pattern", () => {
    expect(
      hasUnrelatedPair([
        { person: "a", chat: "dmA" },
        { person: "b", chat: "dmB" },
      ]),
    ).toBe(true);
    // Sharing a group neither asked in is not seen (the stated residual).
    const members = (chat: string) => (chat === "g" ? ["a", "b"] : []);
    expect(
      hasUnrelatedPair(
        [
          { person: "a", chat: "dmA" },
          { person: "b", chat: "dmB" },
        ],
        members,
      ),
    ).toBe(true);
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
    expect(MIN_PEOPLE).toBe(2);
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

  test("one person in many rooms is capped like one loud room", () => {
    const db = new Database(dbPath);
    const insert = db.query(
      "INSERT INTO rows (ref, kind, chat_guid, sender, ts, text, vec, model, dim) VALUES (?,?,?,?,?,?,x'00','m',1)",
    );
    for (const chat of ["chatG1", "chatG2", "chatG3"]) {
      for (let i = 0; i < 30; i++) {
        insert.run(
          `msg:${chat}-${i}`,
          "message",
          chat,
          "+1777",
          2000 + i,
          `a fairly long question about the family video ${i}`,
        );
      }
    }
    db.close();
    const asks = sampleRecentAsks(dbPath, { sinceMs: 0 });
    // 90 long-enough asks from one person across three rooms: 40 sampled.
    expect(asks.filter((a) => a.sender === "+1777").length).toBe(40);
    // The other people are still there.
    expect(asks.some((a) => a.sender === "+1666")).toBe(true);
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

describe("where curated skills are written", () => {
  test("a curator pass writes under skills/curated, never beside shipped skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "curator-storage-"));
    try {
      const dataDir = join(root, "data");
      const skillsRoot = join(root, "skills");
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(skillsRoot, { recursive: true });

      const db = new Database(join(dataDir, "recall.sqlite"));
      db.exec(
        `CREATE TABLE rows (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_guid TEXT, sender TEXT,
                            ts INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB, model TEXT, dim INTEGER)`,
      );
      const insert = db.query(
        "INSERT INTO rows (ref, kind, chat_guid, sender, ts, text, vec, model, dim) VALUES (?,?,?,?,?,?,x'00','m',1)",
      );
      insert.run(
        "msg:a1",
        "message",
        "chatA",
        "+1555",
        1000,
        "please make me a careful race week plan",
      );
      insert.run(
        "msg:b1",
        "message",
        "chatB",
        "+1666",
        1001,
        "help me build a complete race week plan",
      );
      insert.run(
        "msg:b2",
        "message",
        "chatB",
        "+1666",
        1002,
        "what should my race week schedule include",
      );
      db.close();

      const config = loadConfig(join(import.meta.dir, "..", "config.example.toml"));
      let prompt = "";
      const result = await runCurator({
        config,
        dataDir,
        skillsRoot,
        dbPath: join(dataDir, "installed-skills.json"),
        contacts,
        now: () => 10_000,
        runModel: async (opts) => {
          prompt = opts.input;
          return {
            ok: true,
            text: JSON.stringify({
              skills: [
                {
                  name: "race-week-plan",
                  description: "Build a complete plan for race week.",
                  instructions: "Ask for the race date and distance, then build the schedule.",
                  evidence: [
                    { ref: "msg:a1", chat: "chatA", reading: "asked for a race week plan" },
                    { ref: "msg:b1", chat: "chatB", reading: "asked for a race week plan" },
                    { ref: "msg:b2", chat: "chatB", reading: "asked for a race week schedule" },
                  ],
                  whyNow: "the same planning request appeared in two chats",
                },
              ],
              notes: "",
            }),
            error: null,
            status: 0,
            stderr: "",
            costUsd: 0,
            usage: null,
            model: "test",
            numTurns: 1,
            durationMs: 1,
          };
        },
      });

      expect(result).toMatchObject({ ran: true, created: "race-week-plan" });
      // Chats are opaque tags in the prompt, never a prefix of the guid.
      expect(prompt).toContain(`chat ${chatTag("chatA")},`);
      expect(prompt).not.toMatch(/chat chat[AB]/);
      const saved = JSON.parse(readFileSync(join(dataDir, "installed-skills.json"), "utf8"));
      const provenance = (saved.skills["race-week-plan"].provenance as string[]).join("\n");
      expect(provenance).toContain(`msg:a1 (chat ${chatTag("chatA")})`);
      expect(provenance).not.toContain("(chat chatA)");
      // People are told apart by opaque ids; a handle never reaches the prompt.
      expect(prompt).toContain("person p1");
      expect(prompt).not.toContain("+1555");
      expect(existsSync(join(skillsRoot, "curated", "race-week-plan", "SKILL.md"))).toBe(true);
      expect(existsSync(join(skillsRoot, "race-week-plan"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("at the ceiling", () => {
  test("the pass says so, so the scheduler can wait a full interval", async () => {
    const root = mkdtempSync(join(tmpdir(), "curator-ceiling-"));
    try {
      const config = loadConfig(join(import.meta.dir, "..", "config.example.toml"));
      const dbPath = join(root, "installed-skills.json");
      const skills: Record<string, InstallRecord> = {};
      for (let i = 0; i < config.skill_curator.max_curated_skills; i++) {
        skills[`curated-${i}`] = {
          name: `curated-${i}`,
          source: "curated",
          version: null,
          sha: "x",
          installed_at: 0,
          needs_approval: false,
          approved_at: null,
          has_scripts: false,
          disabled: false,
          category: "curated",
          scope: null,
        };
      }
      writeDb(dbPath, { version: 1, skills });
      const result = await runCurator({
        config,
        dataDir: root,
        skillsRoot: root,
        dbPath,
        contacts,
        runModel: async () => {
          throw new Error("no model call at the ceiling");
        },
      });
      expect(result).toMatchObject({ ran: false, atCeiling: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("who counts as one person", () => {
  // A phone number and an Apple ID on one contact card, which [[contacts]]
  // does not list together.
  const book = {
    lookup: (h: string) => (h === "+15550007777" || h === "pat@example.com" ? "Pat Doe" : null),
  } as unknown as AddressBook;
  const withCards = new ContactBook([], book);

  test("two handles on one contact card are one person", () => {
    expect(personKey(withCards, "+15550007777")).toBe(personKey(withCards, "pat@example.com"));
    expect(personKey(withCards, "+15550008888")).not.toBe(personKey(withCards, "+15550007777"));
  });

  test("two people in one chat are nothing to compare either", async () => {
    const root = mkdtempSync(join(tmpdir(), "curator-room-"));
    try {
      const db = new Database(join(root, "recall.sqlite"));
      db.exec(
        `CREATE TABLE rows (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_guid TEXT, sender TEXT,
                            ts INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB, model TEXT, dim INTEGER)`,
      );
      const insert = db.query(
        "INSERT INTO rows (ref, kind, chat_guid, sender, ts, text, vec, model, dim) VALUES (?,?,?,?,?,?,x'00','m',1)",
      );
      insert.run(
        "msg:f1",
        "message",
        "chatFAM",
        "+15550001111",
        1000,
        "make the next family video",
      );
      insert.run(
        "msg:f2",
        "message",
        "chatFAM",
        "+15550002222",
        1001,
        "make the next family video too",
      );
      db.close();
      const result = await runCurator({
        config: loadConfig(join(import.meta.dir, "..", "config.example.toml")),
        dataDir: root,
        skillsRoot: root,
        dbPath: join(root, "installed-skills.json"),
        contacts,
        now: () => 10_000,
        runModel: async () => {
          throw new Error("one room is nothing to compare");
        },
      });
      expect(result).toMatchObject({ ran: false });
      if (result.ran) throw new Error("unreachable");
      expect(result.reason).toContain("in 1 chat(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the curator resolves people through the operator's books", async () => {
    const root = mkdtempSync(join(tmpdir(), "curator-people-"));
    try {
      const db = new Database(join(root, "recall.sqlite"));
      db.exec(
        `CREATE TABLE rows (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_guid TEXT, sender TEXT,
                            ts INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB, model TEXT, dim INTEGER)`,
      );
      const insert = db.query(
        "INSERT INTO rows (ref, kind, chat_guid, sender, ts, text, vec, model, dim) VALUES (?,?,?,?,?,?,x'00','m',1)",
      );
      insert.run("msg:p1", "message", "chatA", "+15550007777", 1000, "please plan the trip for us");
      insert.run(
        "msg:p2",
        "message",
        "chatB",
        "pat@example.com",
        1001,
        "please plan the trip for me",
      );
      db.close();
      const result = await runCurator({
        config: loadConfig(join(import.meta.dir, "..", "config.example.toml")),
        dataDir: root,
        skillsRoot: root,
        dbPath: join(root, "installed-skills.json"),
        contacts: withCards,
        now: () => 10_000,
        runModel: async () => {
          throw new Error("one person in two chats is nothing to compare");
        },
      });
      expect(result).toMatchObject({ ran: false });
      if (result.ran) throw new Error("unreachable");
      expect(result.reason).toContain("1 person(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("group membership comes from chat.db", () => {
  test("chatMembers lists a group's people as person keys", () => {
    const db = emptyChatDb();
    try {
      const w = new Database(db.path);
      w.exec(`INSERT INTO chat (ROWID, guid) VALUES (1, 'any;+;chatFAM')`);
      w.exec(`INSERT INTO handle (ROWID, id) VALUES (1, '+15550001111'), (2, '+15550002222')`);
      w.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (1, 2)");
      w.close();
      const chatDb = new ChatDb(db.path);
      try {
        const members = chatMembers(chatDb, contacts);
        // As person keys: both handles are saved contacts (Sam, Jordan).
        expect(members("any;+;chatFAM").sort()).toEqual(["name:jordan", "name:sam"]);
        expect(members("any;+;nobody")).toEqual([]);
        expect(chatMembers(undefined, contacts)("any;+;chatFAM")).toEqual([]);
      } finally {
        chatDb.close();
      }
    } finally {
      db.cleanup();
    }
  });

  test("the daemon hands the curator its chat.db", () => {
    const main = readFileSync(join(import.meta.dir, "..", "src/main.ts"), "utf8");
    const start = main.indexOf("new SkillCurator({");
    expect(main.slice(start, main.indexOf("});", start))).toContain("chatDb,");
  });

  test("the curator reads it, so one circle's window costs no model call", async () => {
    const db = emptyChatDb();
    const root = mkdtempSync(join(tmpdir(), "curator-circle-"));
    try {
      const w = new Database(db.path);
      w.exec(`INSERT INTO chat (ROWID, guid) VALUES (1, 'any;+;chatFAM')`);
      w.exec(`INSERT INTO handle (ROWID, id) VALUES (1, '+15550001111'), (2, '+15550002222')`);
      w.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (1, 2)");
      w.close();
      const recall = new Database(join(root, "recall.sqlite"));
      recall.exec(
        `CREATE TABLE rows (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, chat_guid TEXT, sender TEXT,
                            ts INTEGER NOT NULL, text TEXT NOT NULL, vec BLOB, model TEXT, dim INTEGER)`,
      );
      const insert = recall.query(
        "INSERT INTO rows (ref, kind, chat_guid, sender, ts, text, vec, model, dim) VALUES (?,?,?,?,?,?,x'00','m',1)",
      );
      insert.run(
        "msg:c1",
        "message",
        "any;+;chatFAM",
        "+15550001111",
        1000,
        "make the next family video",
      );
      insert.run(
        "msg:c2",
        "message",
        "any;-;+15550002222",
        "+15550002222",
        1001,
        "make the next family video",
      );
      recall.close();
      const chatDb = new ChatDb(db.path);
      try {
        const result = await runCurator({
          config: loadConfig(join(import.meta.dir, "..", "config.example.toml")),
          dataDir: root,
          skillsRoot: root,
          dbPath: join(root, "installed-skills.json"),
          contacts,
          chatDb,
          now: () => 10_000,
          runModel: async () => {
            throw new Error("one circle is nothing to compare");
          },
        });
        expect(result).toMatchObject({ ran: false });
        if (result.ran) throw new Error("unreachable");
        expect(result.reason).toContain("shares a room");
      } finally {
        chatDb.close();
      }
    } finally {
      db.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
