/**
 * Engagement decay end-to-end integration test.
 *
 * The unit test in tests/ghost-budget.test.ts verifies `decayMultiplier`
 * computes the right number from a list of fires. This test exercises
 * the full path:
 *
 *   1. Record 3 fires with outcome=ignored.
 *   2. Call `runGhostTick` (dry-run so we don't spawn Haiku).
 *   3. Verify the multiplier got persisted to prefs (3 ignored → 3.0).
 *   4. Verify `checkCooldown` now uses the new multiplier — a fire that
 *      was outside the original 24h cooldown is still inside the
 *      3.0× = 72h cooldown.
 *
 * This is the load-bearing claim of the decay system: ignored outreach
 * actually makes future outreach less likely.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config.ts";
import { checkCooldown, decayMultiplier } from "../src/ghost/budget.ts";
import { GhostPrefsStore, autoEnrollSessions } from "../src/ghost/prefs.ts";
import { runGhostTick } from "../src/ghost/think.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { AddressBook } from "../src/sessions/address-book.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const JORDAN: SessionKey = "imessage:dm:+19995550999" as SessionKey;

describe("engagement decay E2E", () => {
  test("3 ignored fires → cooldown multiplier becomes 3.0 and gates a fresh tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-decay-"));
    const prefs = new GhostPrefsStore(dir);
    try {
      // 1. Enroll the session
      autoEnrollSessions(prefs, [{ sessionKey: JORDAN, isGroup: false }], {
        dmEnabled: true,
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });
      const initial = prefs.get(JORDAN)!;
      expect(initial.cooldownMultiplier).toBe(1.0);

      // 2. Record 3 fires, all with outcome=ignored
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        const id = prefs.recordFire({
          sessionKey: JORDAN,
          firedAtMs: now - (3 - i) * 6 * 3_600_000, // 18h, 12h, 6h ago
          brief: `fire ${i}`,
          tags: ["test"],
        });
        prefs.recordOutcome(id, "ignored");
      }

      // 3. Sanity-check the decay computation directly first
      const recent = prefs.recentFires(JORDAN, 10);
      expect(decayMultiplier(recent)).toBe(3.0);

      // 4. Run a ghost tick in dry-run mode against an active hours
      //    moment (Monday 14:00 ET). think.ts is supposed to persist
      //    the new multiplier even when bailing on the cooldown gate.
      const config = loadConfig();
      const chatDb = new ChatDb(emptyChatDb().path);
      const contacts = new ContactBook([], new AddressBook());
      const monday14 = Date.parse("2026-05-11T18:00:00Z"); // M-F 9-19 ET
      await runGhostTick(
        {
          sessionKey: JORDAN,
          nowMs: monday14,
          // Bypass active-hours so the test isn't TZ-coupled — the
          // cooldown check still runs.
          bypassActiveHours: true,
          dryRun: true,
        },
        { config, chatDb, contacts, prefs },
      );

      // 5. The multiplier should have been written back to prefs
      const updated = prefs.get(JORDAN)!;
      expect(updated.cooldownMultiplier).toBe(3.0);

      // 6. Verify checkCooldown actually USES the new multiplier.
      //    Intensity 5 base cooldown = 24h. 3.0× = 72h.
      //    Most recent fire was 6h ago — well inside 72h → blocked.
      const blocked = checkCooldown(updated, recent, 5, now);
      expect(blocked.ok).toBe(false);

      // 7. A fire 100h ago (older than 72h) should NOT block.
      const ancient = [
        {
          id: 99,
          sessionKey: JORDAN,
          firedAtMs: now - 100 * 3_600_000,
          brief: "old",
          tags: [],
          outcome: "ignored" as const,
          outcomeAtMs: now - 99 * 3_600_000,
        },
      ];
      const free = checkCooldown(updated, ancient, 5, now);
      expect(free.ok).toBe(true);
    } finally {
      prefs.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("decay self-heals — replacing ignored with engaged drops multiplier back toward 1.0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-decay-"));
    const prefs = new GhostPrefsStore(dir);
    try {
      autoEnrollSessions(prefs, [{ sessionKey: JORDAN, isGroup: false }], {
        dmEnabled: true,
        groupEnabled: false,
        timezone: "America/New_York",
        weeklyCap: 3,
      });

      // Three ignored fires
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        const id = prefs.recordFire({
          sessionKey: JORDAN,
          firedAtMs: now - (5 - i) * 3_600_000,
          brief: `f${i}`,
          tags: [],
        });
        prefs.recordOutcome(id, "ignored");
      }
      const config = loadConfig();
      const chatDb = new ChatDb(emptyChatDb().path);
      const contacts = new ContactBook([], new AddressBook());
      await runGhostTick(
        {
          sessionKey: JORDAN,
          bypassActiveHours: true,
          dryRun: true,
        },
        { config, chatDb, contacts, prefs },
      );
      expect(prefs.get(JORDAN)!.cooldownMultiplier).toBe(3.0);

      // Two new fires, both engaged. Decay window is last 5 fires →
      // [engaged, engaged, ignored, ignored, ignored] = 3 negatives still.
      for (let i = 0; i < 2; i++) {
        const id = prefs.recordFire({
          sessionKey: JORDAN,
          firedAtMs: now + (i + 1) * 60_000,
          brief: `pos${i}`,
          tags: [],
        });
        prefs.recordOutcome(id, "engaged");
      }
      await runGhostTick(
        {
          sessionKey: JORDAN,
          bypassActiveHours: true,
          dryRun: true,
        },
        { config, chatDb, contacts, prefs },
      );
      // Still 3 ignored in the last 5 → 3.0
      expect(prefs.get(JORDAN)!.cooldownMultiplier).toBe(3.0);

      // Three more engaged fires push the ignored ones out of the window
      // → 0 negatives and an all-engaged streak → the positive-
      // reinforcement branch kicks in at 0.75 (shorter cooldown, earned).
      for (let i = 0; i < 3; i++) {
        const id = prefs.recordFire({
          sessionKey: JORDAN,
          firedAtMs: now + (3 + i) * 60_000,
          brief: `pos${i + 2}`,
          tags: [],
        });
        prefs.recordOutcome(id, "engaged");
      }
      await runGhostTick(
        {
          sessionKey: JORDAN,
          bypassActiveHours: true,
          dryRun: true,
        },
        { config, chatDb, contacts, prefs },
      );
      expect(prefs.get(JORDAN)!.cooldownMultiplier).toBe(0.75);
    } finally {
      prefs.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
