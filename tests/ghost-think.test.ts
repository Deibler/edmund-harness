/**
 * Smoke test for the ghost thinking module.
 *
 * Skipped by default. Set RUN_GHOST_SMOKE=1 to spawn a real Haiku call
 * against a synthetic session. Verifies:
 *   - Pre-flight gates short-circuit cleanly (no Haiku call when gated)
 *   - dry-run mode produces a no-act decision without spawning
 *   - JSON parser is robust to common Haiku output shapes (code fences,
 *     leading prose) — tested as pure unit, no LLM
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../src/config/config.ts";
import { GhostPrefsStore, autoEnrollSessions } from "../src/ghost/prefs.ts";
import { describeEngagementTrend, parseGhostOutput, runGhostTick } from "../src/ghost/think.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { AddressBook } from "../src/sessions/address-book.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

/**
 * These tests exercise the per-session gates, so the global switch has to be
 * on regardless of what the machine running them has in config.toml. Reading
 * the operator's own setting made the active-hours test pass at home and fail
 * on a fresh checkout, where the example config ships brown_nose off.
 */
function ghostConfig(): Config {
  const config = loadConfig();
  return { ...config, brown_nose: { ...config.brown_nose, enabled: true } };
}

const JORDAN: SessionKey = "imessage:dm:+19995550042" as SessionKey;

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "edmund-ghost-"));
  const prefs = new GhostPrefsStore(dir);
  return {
    dir,
    prefs,
    cleanup: () => {
      prefs.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("runGhostTick — gated tests (no Haiku call)", () => {
  test("returns act:false with reason when session has no prefs row", async () => {
    const { prefs, cleanup } = tempStore();
    try {
      const config = ghostConfig();
      // No ChatDb / ContactBook reads happen — we bail before history fetch.
      const fakeChatDb = {} as unknown as ChatDb;
      const fakeContacts = new ContactBook([], new AddressBook());
      const dec = await runGhostTick(
        { sessionKey: JORDAN },
        { config, chatDb: fakeChatDb, contacts: fakeContacts, prefs },
      );
      expect(dec.act).toBe(false);
      if (!dec.act) expect(dec.reason).toContain("no prefs row");
    } finally {
      cleanup();
    }
  });

  test("active-hours gate blocks ticks outside the window (no Haiku call)", async () => {
    const { prefs, cleanup } = tempStore();
    try {
      const config = ghostConfig();
      autoEnrollSessions(prefs, [{ sessionKey: JORDAN, isGroup: false }], {
        dmEnabled: true,
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });
      // Saturday 03:00 ET — even the widened every-day windows are closed
      // overnight (weekends open 10:00).
      const sat = Date.parse("2026-05-16T07:00:00Z");
      const fakeChatDb = {} as unknown as ChatDb;
      const fakeContacts = new ContactBook([], new AddressBook());
      const dec = await runGhostTick(
        { sessionKey: JORDAN, nowMs: sat },
        { config, chatDb: fakeChatDb, contacts: fakeContacts, prefs },
      );
      expect(dec.act).toBe(false);
      if (!dec.act) expect(dec.reason).toContain("active_hours");
    } finally {
      cleanup();
    }
  });

  test("disabled session bails before any other check", async () => {
    const { prefs, cleanup } = tempStore();
    try {
      const config = ghostConfig();
      autoEnrollSessions(prefs, [{ sessionKey: JORDAN, isGroup: false }], {
        dmEnabled: false, // enrolled disabled
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });
      const dec = await runGhostTick(
        { sessionKey: JORDAN },
        {
          config,
          chatDb: {} as unknown as ChatDb,
          contacts: new ContactBook([], new AddressBook()),
          prefs,
        },
      );
      expect(dec.act).toBe(false);
      if (!dec.act) expect(dec.reason).toContain("enabled");
    } finally {
      cleanup();
    }
  });
});

// ---- Live test, only with explicit env opt-in ----

const liveEnabled = process.env.RUN_GHOST_SMOKE === "1";
const describeMaybe = liveEnabled ? describe : describe.skip;

describeMaybe("runGhostTick (live haiku)", () => {
  test("runs a real tick against an enrolled session and parses the decision", async () => {
    const { prefs, cleanup } = tempStore();
    try {
      const config = ghostConfig();
      autoEnrollSessions(prefs, [{ sessionKey: JORDAN, isGroup: false }], {
        dmEnabled: true,
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });
      const chatDb = new ChatDb(emptyChatDb().path);
      const contacts = new ContactBook(config.contacts, new AddressBook());
      const dec = await runGhostTick(
        { sessionKey: JORDAN, bypassActiveHours: true, bypassBudgets: true },
        { config, chatDb, contacts, prefs },
      );
      // Either act:true with a brief or act:false with a reason — either
      // way the parser must produce something well-typed.
      expect(typeof dec.act).toBe("boolean");
      if (dec.act) {
        expect(dec.brief.length).toBeGreaterThan(0);
        expect(dec.fireAtMs).toBeGreaterThan(0);
      } else {
        expect(dec.reason.length).toBeGreaterThan(0);
      }
    } finally {
      cleanup();
    }
  });
});

describe("parseGhostOutput — salvage + snooze", () => {
  const NOW = Date.parse("2026-06-10T16:00:00Z");

  test("act:true with null fireAtMs is salvaged (fires now), not dropped", async () => {
    const d = parseGhostOutput(
      JSON.stringify({
        act: true,
        fireAtMs: null,
        expiresAtMs: NOW + 8 * 3_600_000,
        brief: "Casey's OCMD trip rundown — promised Tuesday morning.",
        tags: ["open-promise"],
        confidence: "medium",
      }),
      NOW,
    );
    expect(d.act).toBe(true);
    if (d.act) {
      expect(d.fireAtMs).toBe(NOW);
      expect(d.expiresAtMs).toBe(NOW + 8 * 3_600_000);
    }
  });

  test("act:true with missing expiry defaults to fire+24h", async () => {
    const d = parseGhostOutput(
      JSON.stringify({ act: true, fireAtMs: NOW + 3_600_000, brief: "hook", tags: [] }),
      NOW,
    );
    expect(d.act).toBe(true);
    if (d.act) expect(d.expiresAtMs).toBe(NOW + 3_600_000 + 24 * 3_600_000);
  });

  test("act:true with empty brief is the only fatal salvage case", async () => {
    const d = parseGhostOutput(JSON.stringify({ act: true, fireAtMs: NOW, brief: "" }), NOW);
    expect(d.act).toBe(false);
  });

  test("act:false snoozeHours becomes a clamped snoozeUntilMs", async () => {
    const d = parseGhostOutput(
      JSON.stringify({ act: false, reason: "ball in their court", snoozeHours: 72 }),
      NOW,
    );
    expect(d.act).toBe(false);
    if (!d.act) expect(d.snoozeUntilMs).toBe(NOW + 72 * 3_600_000);
  });

  test("snooze is clamped to the 14-day ceiling", async () => {
    const d = parseGhostOutput(
      JSON.stringify({ act: false, reason: "gone for a month", snoozeHours: 24 * 60 }),
      NOW,
    );
    if (!d.act) expect(d.snoozeUntilMs).toBe(NOW + 14 * 24 * 3_600_000);
  });

  test("plain act:false has no snooze", async () => {
    const d = parseGhostOutput(JSON.stringify({ act: false, reason: "no hook" }), NOW);
    if (!d.act) expect(d.snoozeUntilMs).toBeUndefined();
  });

  test("past fireAtMs is clamped to now, preserving the fire→expiry gap", async () => {
    // The live bug: ghost computed "Wednesday 1pm" as the WRONG YEAR —
    // fire and expiry both a year in the past, enqueue dropped the act
    // as expired.
    const yearAgo = NOW - 365 * 24 * 3_600_000;
    const d = parseGhostOutput(
      JSON.stringify({
        act: true,
        fireAtMs: yearAgo,
        expiresAtMs: yearAgo + 24 * 3_600_000,
        brief: "temu crab legs callback",
        tags: ["dormant-chat"],
      }),
      NOW,
    );
    expect(d.act).toBe(true);
    if (d.act) {
      expect(d.fireAtMs).toBe(NOW);
      expect(d.expiresAtMs).toBe(NOW + 24 * 3_600_000); // gap preserved
    }
  });

  test("far-future fireAtMs is clamped to the 14-day ceiling", async () => {
    const d = parseGhostOutput(
      JSON.stringify({
        act: true,
        fireAtMs: NOW + 400 * 24 * 3_600_000, // wrong-year forward
        brief: "hook",
        tags: [],
      }),
      NOW,
    );
    expect(d.act).toBe(true);
    if (d.act) {
      expect(d.fireAtMs).toBe(NOW + 14 * 24 * 3_600_000);
      expect(d.expiresAtMs).toBe(d.fireAtMs + 24 * 3_600_000);
    }
  });

  test("expiry floor still applies after clamping", async () => {
    // Past fire + tiny expiry gap → clamp to now, then floor at fire+1h.
    const d = parseGhostOutput(
      JSON.stringify({
        act: true,
        fireAtMs: NOW - 3_600_000,
        expiresAtMs: NOW - 3_600_000 + 60_000, // 60s gap
        brief: "hook",
        tags: [],
      }),
      NOW,
    );
    expect(d.act).toBe(true);
    if (d.act) {
      expect(d.fireAtMs).toBe(NOW);
      expect(d.expiresAtMs).toBe(NOW + 3_600_000);
    }
  });
});

describe("decisionFromObject — contextFiles & tool-channel shapes", () => {
  const NOW = Date.parse("2026-06-10T16:00:00Z");

  test("act:true carries absolute contextFiles, drops relative ones", async () => {
    const d = parseGhostOutput(
      JSON.stringify({
        act: true,
        brief: "staged a trip brief",
        contextFiles: ["/abs/path/draft.md", "relative/nope.md"],
      }),
      NOW,
    );
    expect(d.act).toBe(true);
    if (d.act) expect(d.contextFiles).toEqual(["/abs/path/draft.md"]);
  });

  test("act:true with no contextFiles leaves the field undefined", async () => {
    const d = parseGhostOutput(JSON.stringify({ act: true, brief: "x" }), NOW);
    if (d.act) expect(d.contextFiles).toBeUndefined();
  });
});

describe("describeEngagementTrend", () => {
  const NOW = Date.parse("2026-06-10T16:00:00Z");
  const WK = 7 * 86_400_000;
  const msg = (weeksAgo: number, fromMe: boolean, i: number) => ({
    timestampMs: NOW - weeksAgo * WK - i * 60_000,
    fromMe,
    fromHandle: fromMe ? null : "+1555",
    text: "hi",
  });

  test("flags a gone-quiet chat", async () => {
    const history = [
      ...Array.from({ length: 6 }, (_, i) => msg(3, false, i)),
      ...Array.from({ length: 5 }, (_, i) => msg(2, false, i)),
      ...Array.from({ length: 4 }, (_, i) => msg(3, true, i)),
    ];
    const lines = describeEngagementTrend(history as never, NOW);
    expect(lines.join("\n")).toContain("GONE QUIET");
  });

  test("steady chat reads steady-ish, not gone quiet", async () => {
    const history = Array.from({ length: 20 }, (_, i) => msg(i % 4, i % 2 === 0, i));
    const lines = describeEngagementTrend(history as never, NOW);
    expect(lines.join("\n")).not.toContain("GONE QUIET");
  });

  test("too little history says nothing", async () => {
    expect(describeEngagementTrend([msg(0, false, 1)] as never, NOW)).toEqual([]);
  });
});
