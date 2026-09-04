/**
 * Phase-5 learning loops: reacted outcomes with glyph polarity, the
 * cross-session tag rollup, internal-state (chat_silence) probes, and
 * the eval store. Roadmap #27-29.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBubbles } from "../src/evals/judge.ts";
import { personaFingerprint } from "../src/evals/loop.ts";
import { EvalStore } from "../src/evals/store.ts";
import { decayMultiplier, reactionPolarity } from "../src/ghost/budget.ts";
import { classifyOutcome } from "../src/ghost/outcomes.ts";
import { type FireRecord, GhostPrefsStore } from "../src/ghost/prefs.ts";
import {
  MIN_SCORED_FOR_ROLLUP,
  renderTagTrackRecord,
  tagTrackRecord,
} from "../src/ghost/tag-stats.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import { defaultProbe, probeChatSilence } from "../src/triggers/evaluate.ts";

const NOW = 1_750_000_000_000;
const HOUR = 3_600_000;

// ─── reacted outcome classification ──────────────────────────────────

describe("classifyOutcome with reactions", () => {
  test("text reply beats a tapback in the same window", () => {
    expect(
      classifyOutcome({
        firedAtMs: NOW,
        firstInboundMs: NOW + 2 * HOUR,
        firstReaction: { atMs: NOW + 1 * HOUR, glyph: "❤️" },
        nowMs: NOW + 3 * HOUR,
      }),
    ).toEqual({ outcome: "engaged" });
  });

  test("tapback only → reacted with glyph", () => {
    expect(
      classifyOutcome({
        firedAtMs: NOW,
        firstInboundMs: null,
        firstReaction: { atMs: NOW + 1 * HOUR, glyph: "😂" },
        nowMs: NOW + 2 * HOUR,
      }),
    ).toEqual({ outcome: "reacted", glyph: "😂" });
  });

  test("late reply + in-window tapback → reacted (the tapback was the real response)", () => {
    expect(
      classifyOutcome({
        firedAtMs: NOW,
        firstInboundMs: NOW + 30 * HOUR, // outside the 12h engaged window
        firstReaction: { atMs: NOW + 2 * HOUR, glyph: "👍" },
        nowMs: NOW + 31 * HOUR,
      }),
    ).toEqual({ outcome: "reacted", glyph: "👍" });
  });

  test("tapback outside the window carries no verdict — still open", () => {
    expect(
      classifyOutcome({
        firedAtMs: NOW,
        firstInboundMs: null,
        firstReaction: { atMs: NOW + 20 * HOUR, glyph: "❤️" },
        nowMs: NOW + 21 * HOUR,
      }),
    ).toBeNull();
  });
});

// ─── glyph polarity in decay ─────────────────────────────────────────

const fire = (outcome: FireRecord["outcome"], reactionGlyph: string | null = null): FireRecord => ({
  id: 1,
  sessionKey: "dm:+1555" as FireRecord["sessionKey"],
  firedAtMs: NOW,
  brief: "x",
  tags: ["fishing"],
  outcome,
  outcomeAtMs: outcome ? NOW : null,
  reactionGlyph,
  delivered: true,
});

describe("reaction polarity in decayMultiplier", () => {
  test("polarity mapping", () => {
    expect(reactionPolarity("❤️")).toBe("positive");
    expect(reactionPolarity("👎")).toBe("negative");
    expect(reactionPolarity("❓")).toBe("neutral");
    expect(reactionPolarity(null)).toBe("neutral");
  });

  test("👎 tapbacks count as negative outcomes", () => {
    expect(decayMultiplier([fire("reacted", "👎")])).toBe(1.5);
    expect(decayMultiplier([fire("reacted", "👎"), fire("reacted", "👎")])).toBe(2.0);
  });

  test("warm tapbacks count toward the earned-shorter-cooldown lane", () => {
    expect(decayMultiplier([fire("engaged"), fire("reacted", "❤️"), fire("reacted", "😂")])).toBe(
      0.75,
    );
  });

  test("❓ is neutral — neither lane", () => {
    expect(decayMultiplier([fire("engaged"), fire("engaged"), fire("reacted", "❓")])).toBe(1.0);
  });
});

// ─── tag rollup ──────────────────────────────────────────────────────

describe("tagTrackRecord", () => {
  test("aggregates polarity per tag with a minimum-sample floor", () => {
    const fires = [
      fire("engaged"),
      fire("reacted", "❤️"),
      fire("ignored"),
      { ...fire("engaged"), tags: ["thin-tag"] }, // below MIN_SCORED
    ];
    const stats = tagTrackRecord(fires);
    expect(stats.length).toBe(1);
    expect(stats[0]!.tag).toBe("fishing");
    expect(stats[0]!.scored).toBe(3);
    expect(stats[0]!.positive).toBe(2);
    expect(stats[0]!.negative).toBe(1);
    expect(MIN_SCORED_FOR_ROLLUP).toBeGreaterThan(1);

    const block = renderTagTrackRecord(stats);
    expect(block).toContain("TAG_TRACK_RECORD");
    expect(block).toContain("fishing: 2/3");
  });

  test("empty when nothing crosses the floor", () => {
    expect(renderTagTrackRecord(tagTrackRecord([fire("engaged")]))).toBe("");
  });
});

// ─── prefs roundtrip + cross-session query ───────────────────────────

describe("GhostPrefsStore reacted plumbing", () => {
  test("recordOutcome persists the glyph; allScoredFires spans sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-"));
    const store = new GhostPrefsStore(dir);
    try {
      const a = store.recordFire({
        sessionKey: "dm:+15550000001" as FireRecord["sessionKey"],
        firedAtMs: NOW,
        brief: "a",
        tags: ["fishing"],
      });
      store.markDelivered(a);
      store.recordOutcome(a, "reacted", "😂");
      const b = store.recordFire({
        sessionKey: "dm:+15550000002" as FireRecord["sessionKey"],
        firedAtMs: NOW + 1,
        brief: "b",
        tags: ["weather"],
      });
      store.markDelivered(b);
      store.recordOutcome(b, "engaged");
      // vetoed row must not appear in the rollup input
      const c = store.recordFire({
        sessionKey: "dm:+15550000001" as FireRecord["sessionKey"],
        firedAtMs: NOW + 2,
        brief: "c",
        tags: ["fishing"],
      });
      store.recordOutcome(c, "vetoed");

      const rec = store.recentFires("dm:+15550000001" as FireRecord["sessionKey"], 5);
      expect(rec.find((f) => f.id === a)?.reactionGlyph).toBe("😂");

      const all = store.allScoredFires(NOW - 1000);
      expect(all.map((f) => f.id).sort()).toEqual([a, b].sort());
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── chat_silence probe ──────────────────────────────────────────────

function silenceChatDbStub(opts: {
  guid: string | null;
  inboundMs: number | null;
  outboundMs: number | null;
}): ChatDb {
  return {
    query: (sql: string) => ({
      get: (...params: unknown[]) => {
        if (sql.includes("FROM chat c WHERE")) {
          return opts.guid ? { guid: opts.guid } : null;
        }
        if (sql.includes("MAX((m.date")) {
          const fromMe = params[1];
          return { ts_ms: fromMe === 1 ? opts.outboundMs : opts.inboundMs };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    }),
  } as unknown as ChatDb;
}

describe("probeChatSilence", () => {
  test("resolves handle → guid and reports hours of silence", () => {
    const db = silenceChatDbStub({
      guid: "any;-;+15551234567",
      inboundMs: NOW - 120 * HOUR,
      outboundMs: NOW - 2 * HOUR,
    });
    const data = probeChatSilence(db, { handle: "+15551234567" }, NOW) as Record<string, unknown>;
    expect(data.chatGuid).toBe("any;-;+15551234567");
    expect(data.hoursSinceInbound).toBe(120);
    expect(data.hoursSinceOutbound).toBe(2);
  });

  test("chat with no inbound ever reports null (predicates must guard)", () => {
    const db = silenceChatDbStub({ guid: "any;-;+15551234567", inboundMs: null, outboundMs: null });
    const data = probeChatSilence(db, { chatGuid: "any;-;+15551234567" }, NOW) as Record<
      string,
      unknown
    >;
    expect(data.hoursSinceInbound).toBeNull();
  });

  test("unknown handle throws (trigger records the error, never arms silently)", () => {
    const db = silenceChatDbStub({ guid: null, inboundMs: null, outboundMs: null });
    expect(() => probeChatSilence(db, { handle: "+19999999999" }, NOW)).toThrow(/no chat found/);
  });

  test("defaultProbe without chatDb rejects chat_silence sources", async () => {
    const probe = defaultProbe(9222);
    await expect(probe({ kind: "chat_silence", handle: "+15551234567" })).rejects.toThrow(
      /chat\.db/,
    );
  });
});

// ─── eval store ──────────────────────────────────────────────────────

describe("EvalStore", () => {
  test("recordRun computes axis averages; lastRun excludes the new run", () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-"));
    const store = new EvalStore(dir);
    try {
      const r1 = store.recordRun({
        kind: "weekly",
        startedAtMs: NOW,
        model: "judge-1",
        scores: [
          { subject: "chat-a", format: 8, length: 6, persona: 9, note: "clean" },
          { subject: "chat-b", format: 4, length: 8, persona: 7, note: "bullet bomb" },
        ],
      });
      expect(r1.nScored).toBe(2);
      expect(r1.avgFormat).toBe(6);
      expect(r1.avgLength).toBe(7);
      expect(r1.avgPersona).toBe(8);

      const r2 = store.recordRun({
        kind: "weekly",
        startedAtMs: NOW + 1,
        model: "judge-1",
        scores: [{ subject: "chat-a", format: 3, length: 6, persona: 8, note: "regressed" }],
      });
      // Regression comparison: previous run of the same kind, not itself.
      expect(store.lastRun("weekly", r2.id)?.id).toBe(r1.id);
      expect(store.lastRun("probes")).toBeNull();

      store.setMeta("persona_fingerprint", "abc");
      expect(store.getMeta("persona_fingerprint")).toBe("abc");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("personaFingerprint", () => {
  test("stable across calls; sensitive to file content", () => {
    const dir = mkdtempSync(join(tmpdir(), "fp-"));
    try {
      const a = personaFingerprint(dir);
      expect(personaFingerprint(dir)).toBe(a);
      // Adding a fingerprinted file changes it.
      const { writeFileSync } = require("node:fs");
      writeFileSync(join(dir, "IDENTITY.md"), "# I am Edmund");
      const b = personaFingerprint(dir);
      expect(b).not.toBe(a);
      writeFileSync(join(dir, "IDENTITY.md"), "# I am Edmund v2");
      expect(personaFingerprint(dir)).not.toBe(b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── bubble merge for the weekly sampler ─────────────────────────────

describe("mergeBubbles", () => {
  const line = (fromMe: boolean, ts: number, text: string) => ({
    fromMe,
    fromHandle: fromMe ? "" : "+15551234567",
    timestampMs: ts,
    text,
  });

  test("chunked reply bubbles rejoin into one logical message", () => {
    const merged = mergeBubbles([
      line(false, NOW, "whats the plan"),
      line(true, NOW + 1000, "first bubble of a long reply"),
      line(true, NOW + 1400, "second bubble, 400ms later"),
      line(false, NOW + 60_000, "nice"),
    ]);
    expect(merged.length).toBe(3);
    expect(merged[1]!.text).toBe("first bubble of a long reply\nsecond bubble, 400ms later");
  });

  test("same speaker past the window stays separate", () => {
    const merged = mergeBubbles([
      line(true, NOW, "morning"),
      line(true, NOW + 10 * 60_000, "unrelated later message"),
    ]);
    expect(merged.length).toBe(2);
  });
});
