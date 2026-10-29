/**
 * When a message names a time ("the fireball from June"), recall also
 * searches inside that time. Per-turn recall ranks by meaning weighted
 * toward recent, and on 2026-10-26 the August and September fireballs
 * outranked the June one the question was about.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnvelope } from "../src/channels/envelope.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { timeWindowsIn } from "../src/memory/time-scope.ts";
import { VectorStore, normalize } from "../src/memory/vector-store.ts";

const NOW = Date.parse("2026-10-26T04:09:00Z"); // Oct 26, 00:09 Eastern
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

describe("timeWindowsIn", () => {
  test("reads months, dates and spans the way people write them", () => {
    const one = (t: string) => {
      const w = timeWindowsIn(t, NOW);
      expect(w).toHaveLength(1);
      return [
        w[0]!.label,
        day(new Date(w[0]!.sinceMs).toISOString()),
        day(new Date(w[0]!.untilMs).toISOString()),
      ];
    };
    expect(one("the clip of the meteor fireball from June")).toEqual([
      "June",
      "2026-06-01",
      "2026-07-01",
    ]);
    expect(one("what was that thing on Aug 30")).toEqual(["August 30", "2026-08-29", "2026-09-01"]);
    expect(one("remind me what we did on 8/12")).toEqual(["August 12", "2026-08-11", "2026-08-14"]);
    expect(one("early August we talked about")).toEqual([
      "early August",
      "2026-08-01",
      "2026-08-12",
    ]);
    expect(one("I made it like 3 weeks ago")[0]).toBe("3 weeks ago");
    expect(one("last month")[0]).toBe("last month (September)");
  });

  test("a month still to come this year means last year's", () => {
    const [w] = timeWindowsIn("we went in December", NOW);
    expect(day(new Date(w!.sinceMs).toISOString())).toBe("2025-12-01");
  });

  test("ignores words that only look like times", () => {
    for (const t of [
      "you may want to",
      "May I ask",
      "march over there",
      "Cucumber pieces and 1/4 of the the bake",
      "can you hurry up",
      "made it last night",
    ]) {
      expect(timeWindowsIn(t, NOW)).toEqual([]);
    }
  });

  test("never reaches past now", () => {
    const [w] = timeWindowsIn("last week you said", NOW);
    expect(w!.untilMs).toBeLessThanOrEqual(NOW);
  });
});

describe("time-scoped recall", () => {
  test("the named month's match reaches the model, ahead of newer matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "time-scoped-"));
    const store = new VectorStore(join(dir, "r.sqlite"));
    const provider = new HashEmbedProvider("h", 64);
    try {
      const docs = [
        {
          ref: "msg:june",
          ts: Date.parse("2026-06-03T20:33:00Z"),
          text: "bright streak overnight clip",
        },
        // Newer talk on the same subject, closer in wording: it wins the
        // general blocks.
        ...Array.from({ length: 30 }, (_, i) => ({
          ref: `msg:recent${i}`,
          ts: Date.parse("2026-09-20T12:00:00Z") + i * 3_600_000,
          text: `meteor fireball clip from the camera ${i}`,
        })),
      ];
      const { vectors } = await provider.embed(docs.map((d) => d.text));
      store.upsert(
        docs.map((d, i) => ({
          ref: d.ref,
          kind: "message" as const,
          chatGuid: "chatA",
          sender: "me",
          ts: d.ts,
          text: d.text,
          vec: normalize(vectors[i]!),
          model: "hash",
        })),
      );
      const q = "send me the meteor fireball clip from June";
      const base = {
        chatGuid: "chatA",
        limit: 5,
        minScore: 0.2,
        excludeRecentMs: 0,
        deepSplitDays: 7,
        deepLimit: 5,
        nowMs: NOW,
        timeScopedMinScore: 0,
      };
      const without = await autoRecall(q, provider, store, { ...base, timeScope: false });
      expect([...without.recent, ...without.deep].map((h) => h.ref)).not.toContain("msg:june");

      const withScope = await autoRecall(q, provider, store, base);
      expect(withScope.timeScopeLabel).toBe("June");
      expect(withScope.timeScoped.map((h) => h.ref)).toEqual(["msg:june"]);
      expect(withScope.timeScopedLines[0]).toContain("bright streak overnight clip");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("envelope", () => {
  test("shows the time-scoped block first, named by its time", () => {
    const msg: InboundMessage = {
      rowId: 1,
      msgGuid: "g1",
      chatIdentifier: "+15550100091",
      chatGuid: "chatA",
      isGroup: false,
      fromHandle: "+15550100091",
      fromMe: false,
      text: "the fireball from June?",
      timestampMs: NOW,
      attachments: [],
      attachmentTranscripts: {},
      service: "iMessage",
      replyToGuid: null,
    };
    const out = buildEnvelope({
      messages: [msg],
      senderLabel: "Test Person",
      lastInboundMs: null,
      isGroup: false,
      autoRecallTimeLines: [
        "  2026-06-03 16:33 (5 months ago) You (0.62): bright streak overnight clip",
      ],
      autoRecallTimeLabel: "June",
      autoRecallLines: ["  2026-09-20 08:00 (5 weeks ago) You (0.81): meteor fireball clip"],
    });
    const time = out.indexOf("From June (");
    expect(time).toBeGreaterThan(-1);
    expect(time).toBeLessThan(out.indexOf("Relevant past messages"));
    expect(out).toContain("semantic_search` with since/until");
  });
});
