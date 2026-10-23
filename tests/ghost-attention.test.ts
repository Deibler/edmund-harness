/**
 * What the ghost sees and when it looks. Measured over 2026-10-09..23:
 * 288 of 394 ticks landed within 2.5 minutes of Edmund's own reply, the
 * pre-screen declined 371 of 381 without the ghost's calibration, 42
 * decisions cited a cooldown that had already cleared, person files lost
 * Open Items to a head cut (14 of 15 over the cut), and the pre-screen,
 * handed the full tick's submit_decision directive, called tools and wrote
 * into the ghost's notes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import {
  INTERRUPTED_FIRE_MS,
  checkCooldown,
  checkOutstandingFire,
  checkWeeklyCap,
  isContact,
} from "../src/ghost/budget.ts";
import { excerptNotes, excerptPersonFile } from "../src/ghost/excerpt.ts";
import { resolveIntensity } from "../src/ghost/intensity.ts";
import { GhostObserver, SETTLE_MS, settleRemainingMs } from "../src/ghost/observer.ts";
import {
  type BrownNosePrefs,
  type FireRecord,
  GhostPrefsStore,
  autoEnrollSessions,
} from "../src/ghost/prefs.ts";
import {
  GHOST_TOOLS,
  type GhostSmsHistory,
  buildPreScreenSystem,
  buildPromptInput,
  ghostTickTail,
  lastTickTimes,
  parsePreScreen,
  runGhostTick,
  withEagerness,
} from "../src/ghost/think.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import type { StateStore } from "../src/sessions/store.ts";

const NOW = Date.parse("2026-10-21T18:00:00Z");
const H = 3_600_000;

function fire(
  id: number,
  hoursAgo: number,
  outcome: FireRecord["outcome"],
  delivered: boolean,
): FireRecord {
  return {
    id,
    sessionKey: "imessage:dm:+15550100031" as SessionKey,
    firedAtMs: NOW - hoursAgo * H,
    brief: "b",
    tags: [],
    outcome,
    outcomeAtMs: outcome ? NOW : null,
    reactionGlyph: null,
    delivered,
  };
}

const prefs = (o: Partial<BrownNosePrefs> = {}): BrownNosePrefs => ({
  sessionKey: "imessage:dm:+15550100031",
  enabled: true,
  activeHours: [],
  timezone: "America/New_York",
  weeklyCap: 2,
  cooldownMultiplier: 1,
  focusSuggestions: [],
  disabledReason: null,
  disabledAtMs: null,
  updatedAtMs: 0,
  ...o,
});

describe("only fires that reached the person pace the next one", () => {
  const vetoed = fire(1, 1, "vetoed", false);
  const errored = fire(2, 1, "error", false);
  const interrupted = fire(3, INTERRUPTED_FIRE_MS / H + 1, null, false);
  const inFlight = fire(4, 0.2, null, false);
  const delivered = fire(5, 1, null, true);

  test("isContact", () => {
    expect([vetoed, errored, interrupted].map((f) => isContact(f, NOW))).toEqual([
      false,
      false,
      false,
    ]);
    expect([inFlight, delivered].map((f) => isContact(f, NOW))).toEqual([true, true]);
  });

  test("cooldown starts from the last contact, not a veto, error or interruption", () => {
    expect(checkCooldown(prefs(), [vetoed, errored, interrupted], 5, NOW).ok).toBe(true);
    expect(checkCooldown(prefs(), [vetoed, delivered], 5, NOW).ok).toBe(false);
    expect(checkCooldown(prefs(), [inFlight], 5, NOW).ok).toBe(false);
  });

  test("the weekly cap counts contacts only", () => {
    expect(checkWeeklyCap(prefs(), [vetoed, errored, interrupted, delivered], NOW).ok).toBe(true);
    expect(checkWeeklyCap(prefs(), [delivered, inFlight], NOW).ok).toBe(false);
  });

  test("an interrupted fire stops holding the chat open; one in flight still does", () => {
    expect(checkOutstandingFire([interrupted], 0, NOW).ok).toBe(true);
    expect(checkOutstandingFire([inFlight], 0, NOW).ok).toBe(false);
  });
});

describe("excerpts keep what the ghost needs", () => {
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `- detail ${i} ${"x".repeat(60)}`);
  const person = [
    "# Sample Person",
    "## Who They Are",
    ...filler(40),
    "## Our Dynamic",
    ...filler(30),
    "## What I've Learned",
    ...filler(60),
    "## Open Items",
    "_(live threads)_",
    ...Array.from(
      { length: 50 },
      (_, i) => `- **2026-09-${String((i % 28) + 1).padStart(2, "0")}** — older item ${i}`,
    ),
    "- **2026-10-20** — newest open item: dentist on Friday",
  ].join("\n");

  test("a long person file keeps Open Items, its newest entry, and every section", () => {
    expect(person.slice(0, 4000)).not.toContain("## Open Items");
    const ex = excerptPersonFile(person, 6000);
    expect(ex.length).toBeLessThanOrEqual(6200);
    expect(ex).toContain("## Open Items");
    expect(ex).toContain("newest open item: dentist on Friday");
    for (const h of ["## Who They Are", "## Our Dynamic", "## What I've Learned"]) {
      expect(ex).toContain(h);
    }
  });

  const entries = Array.from(
    { length: 30 },
    (_, i) => `## 2026-09-${String(i + 1).padStart(2, "0")} update\n${"note ".repeat(40)}`,
  );
  const newestLast = `# Current Notes\n${entries.join("\n")}\n## 2026-10-22 update\nwatching the race result`;
  const newestFirst = `# Current Notes\n## 2026-10-22 update\nwatching the race result\n${[...entries].reverse().join("\n")}`;

  test("notes keep the newest entry whichever end it is written at", () => {
    for (const notes of [newestLast, newestFirst]) {
      const ex = excerptNotes(notes, 4000);
      expect(ex.length).toBeLessThanOrEqual(4000);
      expect(ex).toContain("watching the race result");
    }
  });

  test("undated notes keep both ends", () => {
    const notes = `start of notes\n${"filler line\n".repeat(800)}end of notes`;
    const ex = excerptNotes(notes, 2000);
    expect(ex).toContain("start of notes");
    expect(ex).toContain("end of notes");
  });
});

describe("the pre-screen judges with the ghost's calibration", () => {
  const GHOST = [
    "# Ghost",
    "You work behind one chat.",
    "## Your decision is a TOOL CALL",
    "End every tick by calling submit_decision exactly once.",
    "## Calibration comes first",
    "`{{eagernessClause}}`",
    "## When NOT to act",
    "- The user just replied <1h ago.",
    "## Workspace",
    "- current.md is your memory.",
  ].join("\n");

  test("its intensity reaches the pre-screen", () => {
    const low = buildPreScreenSystem(3, GHOST);
    const high = buildPreScreenSystem(8, GHOST);
    expect(low).toContain(resolveIntensity(3).eagerness);
    expect(high).toContain(resolveIntensity(8).eagerness);
    expect(low).not.toBe(high);
  });

  test("it gets when to act, not the full tick's mechanics", () => {
    const sys = buildPreScreenSystem(6, GHOST);
    expect(sys).toContain("The user just replied <1h ago.");
    expect(sys).not.toContain("End every tick by calling submit_decision");
    expect(sys).not.toContain("current.md is your memory");
  });

  test("a GHOST.md without the placeholder still carries the intensity", () => {
    const template = "# Ghost\n## When to act\n- a real hook";
    expect(withEagerness(template, 7)).toContain(resolveIntensity(7).eagerness);
    expect(buildPreScreenSystem(7, template)).toContain(resolveIntensity(7).eagerness);
    expect(buildPreScreenSystem(7, null)).toContain(resolveIntensity(7).eagerness);
  });

  test("its answer parses, and anything else is no verdict", () => {
    expect(parsePreScreen('```json\n{"proceed": false, "reason": "mid-flow"}\n```')).toEqual({
      proceed: false,
      reason: "mid-flow",
    });
    expect(parsePreScreen("I'll call submit_decision now.")).toBeNull();
    expect(parsePreScreen('{"reason": "no proceed field"}')).toBeNull();
  });
});

describe("the shared prompt and the full tick's tail", () => {
  const SID = "CH00000000000000000000000000000031";
  const KEY = `sms:group:${SID}` as SessionKey;
  const config = ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    brown_nose: { enabled: true },
  });
  const contacts = {
    displayName: () => null,
    label: () => null,
    canon: (h: string) => h,
  } as unknown as ContactBook;
  const chatDb = new Proxy(
    {},
    {
      get() {
        throw new Error("chat.db must not be read for an SMS session");
      },
    },
  ) as unknown as ChatDb;
  const sms: GhostSmsHistory = {
    history: () => [
      {
        rowId: 1,
        timestampMs: NOW - 5 * 60_000,
        fromHandle: "+15550100032",
        fromMe: false,
        text: "who is driving saturday",
        isTapback: false,
        tapbackTargetIsMe: false,
        tapbackTargetHandle: "",
      },
    ],
  };
  let dir: string;
  let store: GhostPrefsStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ghost-attention-"));
    store = new GhostPrefsStore(dir);
    autoEnrollSessions(store, [{ sessionKey: KEY, isGroup: true }], {
      dmEnabled: true,
      groupEnabled: true,
      timezone: "America/New_York",
      weeklyCap: 3,
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the context the pre-screen reads has no tool directive or workspace", () => {
    const p = buildPromptInput({
      sessionKey: KEY,
      sessionPrefs: store.get(KEY)!,
      nowMs: NOW,
      config,
      chatDb,
      contacts,
      sms,
      recentFires: [],
    });
    expect(p).not.toContain("submit_decision");
    expect(p).not.toContain("WORKSPACE");
    expect(p).not.toContain("COOLDOWN_HOURS_EFFECTIVE");
    expect(p).toContain("PACING: cooldown clear, 0 of 3");
    const tail = ghostTickTail(KEY);
    expect(tail).toContain("WORKSPACE");
    expect(tail).toContain("CALLING the submit_decision tool exactly once");
  });

  test("a tick's trigger is stamped on its decision and read back after a restart", async () => {
    await runGhostTick(
      { sessionKey: KEY, nowMs: NOW, bypassActiveHours: true, dryRun: true, trigger: "quiet_4h" },
      { config, chatDb, contacts, prefs: store, sms },
    );
    const seen = lastTickTimes(KEY);
    expect(seen.any).toBe(NOW);
    expect(seen.byTrigger.get("quiet_4h")).toBe(NOW);

    const observer = new GhostObserver({
      config,
      chatDb,
      contacts,
      prefs: store,
      crons: {} as never,
      state: { getSession: () => null } as unknown as StateStore,
      sms,
    });
    observer.seedTickHistory();
    const inner = observer as unknown as { lastTickAtMs: Map<string, number> };
    expect(inner.lastTickAtMs.get(KEY)).toBe(NOW);
  });

  test("the full tick names its tools: ToolSearch for submit_decision, no Bash", () => {
    const tools = GHOST_TOOLS.split(",");
    expect(tools).toContain("ToolSearch");
    expect(tools).not.toContain("Bash");
    const src = readFileSync(join(import.meta.dir, "../src/ghost/think.ts"), "utf8");
    const pre = src.slice(
      src.indexOf("async function runPreScreen"),
      src.indexOf("export async function runGhostTick"),
    );
    const tick = src.slice(src.indexOf("res = await runModelOneShot("));
    expect(tick.slice(0, 600)).toMatch(/"--tools",\s*GHOST_TOOLS,/);
    expect(tick.slice(0, 900)).toContain("input: tickInput,");
    const preArgs = pre.slice(pre.indexOf("args: ["), pre.indexOf("input: promptInput"));
    expect(preArgs).toContain("--append-system-prompt");
    expect(preArgs).not.toContain("--tools");
    expect(preArgs).not.toContain("--mcp-config");
  });
});

describe("a reply arms a tick for when the exchange has settled", () => {
  test("not while the chat is moving", () => {
    expect(settleRemainingMs(0)).toBe(SETTLE_MS);
    expect(settleRemainingMs(2 * 60_000)).toBe(SETTLE_MS - 2 * 60_000);
    expect(settleRemainingMs(SETTLE_MS)).toBe(0);
  });

  test("the observer wires both in", () => {
    const src = readFileSync(join(import.meta.dir, "../src/ghost/observer.ts"), "utf8");
    const start = src.slice(src.indexOf("  start(): void {"), src.indexOf("  stop(): void {"));
    expect(start).toContain("this.seedTickHistory();");
    const replied = src.slice(
      src.indexOf("  onMainReplied("),
      src.indexOf("  private scheduleNext("),
    );
    expect(replied).toContain("settleRemainingMs(this.quietForMs(");
    expect(replied).toContain('this.runReactiveTick(sessionKey, "settled")');
  });

  test("quiet is measured from the latest message either way", () => {
    const observer = new GhostObserver({
      config: ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} }),
      chatDb: {} as ChatDb,
      contacts: {} as ContactBook,
      prefs: {} as GhostPrefsStore,
      crons: {} as never,
      state: {
        getSession: () => ({ lastInboundMs: NOW - 40 * 60_000, lastOutboundMs: NOW - 3 * 60_000 }),
      } as unknown as StateStore,
    });
    expect(observer.quietForMs("imessage:dm:+15550100033" as SessionKey, NOW)).toBe(3 * 60_000);
  });
});
