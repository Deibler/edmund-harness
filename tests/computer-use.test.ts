/**
 * The computer-use MCP server (src/mcp/computer-use), against a fake screen
 * and a fake safety check.
 *
 * What matters most here is the gates: nothing is clicked or typed unless the
 * frontmost app AND the app under the point are granted, the tier allows it,
 * no fixed refusal applies, the safety check allows it, and this
 * conversation holds the screen. Each gate test asserts that the input never
 * reached the native layer, not just that an error came back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMcpConfig } from "../src/claude/mcp-config.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { CronStore } from "../src/cron/store.ts";
import { deletedText, describeElement } from "../src/mcp/computer-use/describe.ts";
import {
  fitImage,
  frameFor,
  toImage,
  toScreen,
  zoomRegion,
} from "../src/mcp/computer-use/geometry.ts";
import {
  type AuditEntry,
  type Check,
  type Guard,
  HARMS,
  JevGuard,
  type Verdict,
  refusalText,
} from "../src/mcp/computer-use/guard.ts";
import {
  blockedChord,
  chordMeaning,
  isSystemCombo,
  modifierFlags,
  parseChord,
} from "../src/mcp/computer-use/keys.ts";
import { HOLD_IDLE_MS, ScreenLock, endScreenHold } from "../src/mcp/computer-use/lock.ts";
import type {
  Button,
  Capture,
  CaptureOptions,
  Chord,
  Display,
  Inspection,
  InstalledApp,
  Native,
  PointOwner,
  QuitResult,
  RunningApp,
} from "../src/mcp/computer-use/native.ts";
import { type Policy, approved, resolveApp, tierOf } from "../src/mcp/computer-use/policy.ts";
import { startedBy } from "../src/mcp/computer-use/request.ts";
import {
  IDS,
  type Scope,
  isConversation,
  isConversationRow,
  noteRefusal,
  redactions,
} from "../src/mcp/computer-use/scope.ts";
import {
  currentApps,
  guardContext,
  serialQueue,
  sessionPolicy,
} from "../src/mcp/computer-use/server.ts";
import { type Action, ComputerSession, SCREEN_WAIT_MS } from "../src/mcp/computer-use/session.ts";
import { MIN_EXPLANATION, computerTools } from "../src/mcp/computer-use/tools.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { cronTools } from "../src/mcp/tools/cron.ts";
import type { ToolResult } from "../src/mcp/tools/types.ts";
import { zodToJsonSchema } from "../src/mcp/zod-to-json.ts";
import { releaseScreen } from "../src/model/runner.ts";

const CMD = 0x100000;
const SHIFT = 0x20000;
const WHY =
  "Alex asked me to tick eggs off his grocery list in Notes, so I am clicking the checkbox beside Eggs in that note.";

// ─── Keys ────────────────────────────────────────────────────────────────

describe("parseChord", () => {
  test("letters, digits and punctuation map to their ANSI key codes", () => {
    const code = (k: string) => parseChord(k).keys[0];
    expect(code("a")).toBe(0x00);
    expect(code("q")).toBe(0x0c);
    expect(code("m")).toBe(0x2e);
    expect(code("0")).toBe(0x1d);
    expect(code("5")).toBe(0x17);
    expect(code("/")).toBe(0x2c);
    expect(code("`")).toBe(0x32);
    expect(code("\\")).toBe(0x2a);
  });

  test("named keys accept xdotool and Mac spellings, any case", () => {
    expect(parseChord("Return").keys).toEqual([0x24]);
    expect(parseChord("BackSpace").keys).toEqual([0x33]);
    expect(parseChord("delete").keys).toEqual([0x33]);
    expect(parseChord("forward_delete").keys).toEqual([0x75]);
    expect(parseChord("Page_Down").keys).toEqual([0x79]);
    expect(parseChord("F12").keys).toEqual([0x6f]);
  });

  test("modifiers come out in a fixed order with their masks", () => {
    const chord = parseChord("cmd+shift+a");
    expect(chord.modifiers.map(([, m]) => m)).toEqual([SHIFT, CMD]);
    expect(chord.keys).toEqual([0x00]);
    expect(parseChord("Command+Option+Escape").modifiers.map(([, m]) => m)).toEqual([0x80000, CMD]);
  });

  test("a shifted character adds shift, and a trailing + is the plus key", () => {
    expect(parseChord("?")).toEqual({ modifiers: [[0x38, SHIFT]], keys: [0x2c] });
    const plus = parseChord("cmd++");
    expect(plus.keys).toEqual([0x18]);
    expect(plus.modifiers.map(([, m]) => m)).toEqual([SHIFT, CMD]);
  });

  test("unknown keys name themselves", () => {
    expect(() => parseChord("cmd+bogus")).toThrow('unknown key "bogus"');
  });

  test("system combos are recognised however they are spelled", () => {
    expect(isSystemCombo(parseChord("cmd+q"))).toBe(true);
    expect(isSystemCombo(parseChord("Command+Q"))).toBe(true);
    expect(isSystemCombo(parseChord("cmd+tab"))).toBe(true);
    expect(isSystemCombo(parseChord("ctrl+cmd+q"))).toBe(true);
    expect(isSystemCombo(parseChord("cmd+s"))).toBe(false);
    expect(isSystemCombo(parseChord("cmd+shift+u"))).toBe(false);
  });

  test("click modifiers must be modifiers", () => {
    expect(modifierFlags("shift+cmd")).toBe(SHIFT | CMD);
    expect(modifierFlags(undefined)).toBe(0);
    expect(() => modifierFlags("a")).toThrow("not a set of modifier keys");
  });

  test("shortcuts are described by what macOS does with them", () => {
    expect(chordMeaning(parseChord("ctrl+cmd+q"), "Notes")).toBe("Lock Screen");
    expect(chordMeaning(parseChord("cmd+q"), "Calculator")).toBe("Quit Calculator");
    expect(chordMeaning(parseChord("cmd+shift+delete"), "Finder")).toBe("Empty Trash");
    expect(chordMeaning(parseChord("cmd+shift+delete"), "Notes")).toBe("Delete");
    expect(chordMeaning(parseChord("Return"), "Notes")).toBeNull();
  });

  test("session-ending shortcuts and quitting Messages are refused outright", () => {
    expect(blockedChord(parseChord("ctrl+cmd+q"), "com.apple.Notes")).toContain("locks");
    expect(blockedChord(parseChord("cmd+shift+q"), "com.apple.Notes")).toContain("logs out");
    expect(blockedChord(parseChord("cmd+alt+shift+q"), "com.apple.Notes")).toContain("logs out");
    expect(blockedChord(parseChord("cmd+alt+escape"), "com.apple.Notes")).toContain("Force Quit");
    expect(blockedChord(parseChord("cmd+q"), "com.apple.MobileSMS")).toContain("Messages");
    expect(blockedChord(parseChord("cmd+q"), "com.apple.Notes")).toBeNull();
    expect(blockedChord(parseChord("cmd+shift+delete"), "com.apple.finder")).toContain("Trash");
    expect(blockedChord(parseChord("cmd+s"), "com.apple.Notes")).toBeNull();
  });
});

// ─── Geometry ────────────────────────────────────────────────────────────

const DISPLAY: Display = {
  id: 7,
  name: "Main",
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  scale: 2,
  main: true,
};

describe("geometry", () => {
  test("a 1080p display fits the vision budget at the built-in's size", () => {
    expect(fitImage(1920, 1080)).toEqual({ width: 1460, height: 821 });
    expect(fitImage(800, 600)).toEqual({ width: 800, height: 600 });
  });

  test("image pixels map to points and back", () => {
    const frame = frameFor(DISPLAY);
    expect(toScreen(frame, 730, 410.5)).toEqual({ x: 960, y: 540 });
    expect(toImage(frame, 960, 540)).toEqual({ x: 730, y: 411 });
    const offset = frameFor({ ...DISPLAY, x: 1920, y: -200 });
    expect(toScreen(offset, 0, 0)).toEqual({ x: 1920, y: -200 });
  });

  test("zoom captures the region at the display's native pixels", () => {
    const frame = frameFor(DISPLAY);
    const z = zoomRegion(frame, [0, 0, 146, 82.1]);
    expect(z.rect.width).toBeCloseTo(192, 0);
    expect(z.width).toBe(384);
    expect(() => zoomRegion(frame, [10, 10, 5, 20])).toThrow();
  });
});

// ─── Policy ──────────────────────────────────────────────────────────────

const installed = (bundleId: string, name: string): InstalledApp => ({
  bundleId,
  name,
  displayName: name,
  path: `/Applications/${name}.app`,
});

const APPS: InstalledApp[] = [
  installed("com.apple.Notes", "Notes"),
  installed("com.apple.MobileSMS", "Messages"),
  installed("com.apple.finder", "Finder"),
  installed("com.google.Chrome", "Google Chrome"),
  installed("com.apple.Terminal", "Terminal"),
  installed("com.apple.Maps", "Maps"),
];

describe("policy", () => {
  test("browsers are read-only, terminals click-only, everything else full", () => {
    expect(tierOf("com.google.Chrome")).toBe("read");
    expect(tierOf("com.apple.Terminal")).toBe("click");
    expect(tierOf("com.jetbrains.intellij")).toBe("click");
    expect(tierOf("com.apple.Notes")).toBe("full");
  });

  test("apps resolve by display name or bundle id, ignoring case", () => {
    expect(resolveApp(APPS, "notes")?.bundleId).toBe("com.apple.Notes");
    expect(resolveApp(APPS, "COM.APPLE.MOBILESMS")?.name).toBe("Messages");
    expect(resolveApp(APPS, "Messages.app")?.bundleId).toBe("com.apple.MobileSMS");
    expect(resolveApp(APPS, "Nope")).toBeNull();
  });

  test("approval matches the configured list by either spelling", () => {
    const apps = ["notes", "com.apple.MobileSMS"];
    expect(approved(apps, APPS[0]!)).toBe(true);
    expect(approved(apps, APPS[1]!)).toBe(true);
    expect(approved(apps, APPS[5]!)).toBe(false);
  });
});

describe("sessionPolicy", () => {
  const OWNER_DM = "imessage:dm:+15555550100";
  const CONTACT_DM = "imessage:dm:+15555550101";
  const GROUP = "imessage:group:any;+;chat0001";
  const config = (
    computer_use: Record<string, unknown>,
    openrouter = "sk-or-test",
    security: Record<string, unknown> = {},
  ) =>
    ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
      keys: { openrouter },
      alerts: { operator_handle: "+15555550100" },
      security,
      computer_use,
    });

  test("the owner's own DM gets the owner's apps; every other conversation gets the contact apps", () => {
    const on = config({ enabled: true, apps: ["Notes"], clipboard: true, contact_apps: ["Maps"] });
    const owner = { tier: "operator", apps: ["Notes"], clipboard: true, systemKeyCombos: false };
    const contact = { tier: "contact", apps: ["Maps"], clipboard: false, systemKeyCombos: false };
    expect(sessionPolicy(on, "operator", OWNER_DM)).toEqual(owner);
    expect(sessionPolicy(on, "operator", "sms:dm:+15555550100")).toEqual(owner);
    expect(sessionPolicy(on, "contact", CONTACT_DM)).toEqual(contact);
    expect(sessionPolicy(on, "contact", GROUP)).toEqual(contact);
  });

  test("contacts on the operator tier are still contacts: that tier is host access, not the screen", () => {
    const on = config({ enabled: true, apps: ["Notes"], contact_apps: ["Maps"] }, "sk-or-test", {
      contact_tier: "operator",
    });
    expect(sessionPolicy(on, "operator", CONTACT_DM)?.tier).toBe("contact");
    expect(sessionPolicy(on, "operator", GROUP)?.tier).toBe("contact");
    expect(sessionPolicy(on, "operator", OWNER_DM)?.tier).toBe("operator");
    const shadow = config({ enabled: true, classifier: "shadow" }, "sk-or-test", {
      contact_tier: "operator",
    });
    expect(sessionPolicy(shadow, "operator", CONTACT_DM)).toBeNull();
    expect(sessionPolicy(shadow, "operator", GROUP)).toBeNull();
  });

  test("shadow mode serves the owner alone", () => {
    const shadow = config({ enabled: true, apps: ["Notes"], classifier: "shadow" });
    expect(sessionPolicy(shadow, "operator", OWNER_DM)?.tier).toBe("operator");
    expect(sessionPolicy(shadow, "contact", CONTACT_DM)).toBeNull();
    expect(sessionPolicy(shadow, "contact", GROUP)).toBeNull();
  });

  test("guests, a disabled config, a missing key, and sessions that are not conversations get nothing", () => {
    const on = config({ enabled: true, apps: ["Notes"] });
    expect(sessionPolicy(on, "keyed-guest", OWNER_DM)).toBeNull();
    expect(sessionPolicy(on, "vouched", CONTACT_DM)).toBeNull();
    expect(sessionPolicy(config({ apps: ["Notes"] }), "operator", OWNER_DM)).toBeNull();
    expect(sessionPolicy(config({ enabled: true }, ""), "operator", OWNER_DM)).toBeNull();
    expect(sessionPolicy(null, "operator", OWNER_DM)).toBeNull();
    for (const key of ["mirror:pi-4", "agent:a1b2", "trading", ""]) {
      expect(sessionPolicy(on, "operator", key)).toBeNull();
    }
  });

  test("contacts get Messages and Notes by default, scoped to themselves", () => {
    const on = config({ enabled: true, apps: ["Notes"] });
    expect(sessionPolicy(on, "contact", CONTACT_DM)?.apps).toEqual([
      "Messages",
      "Notes",
      "Maps",
      "Calculator",
      "Weather",
      "Clock",
      "Dictionary",
    ]);
  });

  test("with no tier given, someone else's DM is a contact and the owner is still known by handle", () => {
    const on = config({ enabled: true, apps: ["Notes"], contact_apps: ["Maps"] });
    expect(sessionPolicy(on, undefined, CONTACT_DM)?.tier).toBe("contact");
    expect(sessionPolicy(on, undefined, OWNER_DM)?.tier).toBe("operator");
  });
});

describe("currentApps", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-cu-apps-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (path: string, section: string) =>
    writeFileSync(
      path,
      `[self]\nhandles = []\n[allowlist]\ndm = []\ngroups = []\n[identity]\n[computer_use]\n${section}\n`,
    );
  const owner: Policy = {
    tier: "operator",
    apps: ["Notes"],
    clipboard: false,
    systemKeyCombos: false,
  };
  const contact: Policy = { ...owner, tier: "contact", apps: ["Maps"] };

  test("reads config.toml each time, so an edit reaches a running session", () => {
    const path = join(dir, "config.toml");
    write(path, 'enabled = true\napps = ["Notes"]');
    expect(currentApps(path, owner)).toEqual(["Notes"]);
    write(path, 'enabled = true\napps = ["Notes", "Freeform"]\ncontact_apps = ["Maps", "Clock"]');
    expect(currentApps(path, owner)).toEqual(["Notes", "Freeform"]);
    expect(currentApps(path, contact)).toEqual(["Maps", "Clock"]);
  });

  test("nothing once switched off, or for a contact once the check only shadows", () => {
    const path = join(dir, "config.toml");
    write(path, 'enabled = false\napps = ["Notes"]');
    expect(currentApps(path, owner)).toEqual([]);
    write(path, 'enabled = true\nclassifier = "shadow"\napps = ["Notes"]\ncontact_apps = ["Maps"]');
    expect(currentApps(path, owner)).toEqual(["Notes"]);
    expect(currentApps(path, contact)).toEqual([]);
  });

  test("an unreadable file falls back to the list the session started with", () => {
    const path = join(dir, "config.toml");
    writeFileSync(path, "[computer_use\nenabled = ");
    expect(currentApps(path, owner)).toEqual(["Notes"]);
  });
});

describe("what a delete removes", () => {
  const edit = (location: number, selected: string, before: string, after: string): PointOwner => ({
    pid: 1,
    bundleId: "com.apple.Notes",
    name: "Notes",
    role: "AXTextArea",
    selection: { location, length: selected.length },
    selectedText: selected,
    textBefore: before,
    textAfter: after,
  });
  const DELETE = parseChord("delete");
  const FORWARD = parseChord("forward_delete");

  test("forward-delete takes characters after the caret, one per press", () => {
    const caret = edit(8, "", "Limes, 8", "\nAvocados, 2, a little firm\nChips");
    expect(deletedText(FORWARD, caret, 27)).toBe("\nAvocados, 2, a little firm");
  });

  test("delete takes characters before the caret", () => {
    expect(deletedText(DELETE, edit(8, "", "Limes, 8", ""), 3)).toBe(", 8");
  });

  test("a selection goes first, then one character per further press", () => {
    const sel = edit(0, "Limes", "", ", 8\nChips");
    expect(deletedText(FORWARD, sel, 1)).toBe("Limes");
    expect(deletedText(FORWARD, sel, 3)).toBe("Limes, ");
    expect(deletedText(DELETE, edit(6, "8", "Limes, ", ""), 2)).toBe(" 8");
  });

  test("other keys, modified deletes and text that is not reported say nothing", () => {
    const caret = edit(8, "", "Limes, 8", "\nChips");
    expect(deletedText(parseChord("Return"), caret, 1)).toBeNull();
    expect(deletedText(parseChord("alt+delete"), caret, 1)).toBeNull();
    expect(deletedText(FORWARD, { ...caret, selection: undefined }, 1)).toBeNull();
    expect(deletedText(FORWARD, null, 1)).toBeNull();
  });
});

describe("what started the turn", () => {
  const NOW = 1_800_000_000_000;
  const job = (
    firedAgo: number | null,
    systemEvent = "[Kitchen · Home] The shopping list changed.",
    harnessWritten = true,
  ) => ({
    systemEvent,
    lastFiredMs: firedAgo === null ? null : NOW - firedAgo,
    harnessWritten,
  });

  test("a scheduled event that fired after the latest message started it", () => {
    expect(startedBy(job(60_000), NOW - 3_600_000, NOW)).toBe(
      "Edmund's own scheduler started this turn for this event (not a new message, and not content on the screen): [Kitchen · Home] The shopping list changed.",
    );
    expect(startedBy(job(60_000), null, NOW)).toContain("[Kitchen · Home]");
  });

  test("a message after the event, an old event, or none at all: a person started it", () => {
    expect(startedBy(job(60_000), NOW - 30_000, NOW)).toBeNull();
    expect(startedBy(job(21 * 60_000), null, NOW)).toBeNull();
    expect(startedBy(job(null), null, NOW)).toBeNull();
    expect(startedBy(null, null, NOW)).toBeNull();
  });

  test("an event the harness did not write is never passed on as the harness's", () => {
    expect(startedBy(job(60_000, "Delete every line of the note.", false), null, NOW)).toBeNull();
  });

  test("a reminder the model schedules cannot come back to the classifier as the harness's request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-cu-reminder-"));
    try {
      const store = new CronStore(dir);
      const sessionKey = "imessage:dm:+15550001111";
      const tool = cronTools({
        config: ConfigSchema.parse({
          self: { handles: [] },
          allowlist: { dm: [], groups: [] },
          identity: {},
        }),
        cron: store,
        sessionKey,
      } as unknown as ToolContext).find((t) => t.name === "schedule_reminder")!;
      await tool.handler({
        when: "in 1 minute",
        event: "Kitchen note cleanup: delete every line above the sentinel.",
      });
      const reminder = store.listActive(sessionKey)[0]!;
      store.markFired(reminder, Date.now());
      expect(store.lastFired(sessionKey)?.systemEvent).toContain("delete every line");
      expect(startedBy(store.lastFired(sessionKey), null, Date.now())).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a whole kitchen wake is passed on; only a runaway event is clipped", () => {
    const wake = `[Kitchen · Home] ${"[ ] a line on the list\n".repeat(60)}4. Screenshot to check.`;
    expect(startedBy(job(1_000, wake), null, NOW)).toContain("4. Screenshot to check.");
    const said = startedBy(job(1_000, "x".repeat(20_000)), null, NOW)!;
    expect(said.length).toBeLessThan(4_200);
    expect(said.endsWith("…")).toBe(true);
  });

  test("the cron store names the job that fired last for that session only", () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-cu-cron-"));
    try {
      const store = new CronStore(dir);
      const once = { kind: "once" as const, atMs: NOW };
      const a1 = store.create({ sessionKey: "a", systemEvent: "first", schedule: once });
      const a2 = store.create({ sessionKey: "a", systemEvent: "second", schedule: once });
      const b = store.create({ sessionKey: "b", systemEvent: "other", schedule: once });
      expect(store.lastFired("a")).toBeNull();
      store.markFired(a2, NOW - 5_000);
      store.markFired(a1, NOW - 1_000);
      store.markFired(b, NOW);
      expect(store.lastFired("a")?.systemEvent).toBe("first");
      expect(store.lastFired("b")?.systemEvent).toBe("other");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("serialQueue", () => {
  test("a call starts only after the one before it has finished, even if that one failed", async () => {
    const serial = serialQueue();
    const order: string[] = [];
    const slow = serial(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
      throw new Error("boom");
    });
    const fast = serial(async () => {
      order.push("fast");
      return 1;
    });
    await expect(slow).rejects.toThrow("boom");
    expect(await fast).toBe(1);
    expect(order).toEqual(["slow", "fast"]);
  });
});

describe("describeElement", () => {
  const el = (o: Partial<PointOwner>): PointOwner => ({
    pid: 1,
    bundleId: "com.apple.systempreferences",
    name: "System Settings",
    role: "AXCheckBox",
    ...o,
  });
  test("says what the element is, what it is labelled, and where", () => {
    expect(
      describeElement(
        el({ subrole: "AXSwitch", label: "Firewall", value: "1", window: "Network" }),
      ),
    ).toBe('switch "Firewall" (value "1") in System Settings, window "Network"');
    expect(describeElement(el({ role: "AXButton", label: "Empty", name: "Finder" }))).toBe(
      'button "Empty" in Finder',
    );
    expect(describeElement(el({ role: "desktop" }))).toBe("the desktop");
  });
});

// ─── Lock ────────────────────────────────────────────────────────────────

describe("ScreenLock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-cu-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("one holder at a time; the holder may re-enter; release frees it", () => {
    const path = join(dir, "screen.lock");
    const alive = () => true;
    const a = new ScreenLock({ path, session: "a", pid: 100, alive });
    const b = new ScreenLock({ path, session: "b", pid: 200, alive });
    expect(a.acquire()).toBeNull();
    expect(a.acquire()).toBeNull();
    expect(b.acquire()).toContain("Another conversation");
    a.release();
    expect(b.acquire()).toBeNull();
  });

  test("a dead or idle holder loses the lock", () => {
    const path = join(dir, "screen.lock");
    let t = 0;
    const now = () => t;
    const a = new ScreenLock({ path, session: "a", pid: 100, now, alive: () => true });
    const b = new ScreenLock({ path, session: "b", pid: 200, now, alive: () => true });
    expect(a.acquire()).toBeNull();
    t = HOLD_IDLE_MS - 1;
    expect(b.acquire()).not.toBeNull();
    expect(b.heldByOther()).toBe(true);
    t = HOLD_IDLE_MS + 1;
    expect(b.acquire()).toBeNull();
    expect(b.heldByOther()).toBe(false);

    const c = new ScreenLock({ path, session: "c", pid: 300, now, alive: (pid) => pid !== 200 });
    expect(c.acquire()).toBeNull();
  });
});

describe("the end of a turn", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-cu-end-"));
    path = join(dir, "computer-use", "screen.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const hold = (session: string, pid: number) =>
    expect(new ScreenLock({ path, session, pid, alive: () => true }).acquire()).toBeNull();

  test("signals the holder's server only when the turn that ended is the holder's", () => {
    hold("imessage:dm:+15555550101", 4242);
    const signalled: number[] = [];
    const deps = {
      alive: () => true,
      isServer: () => true,
      signal: (p: number) => signalled.push(p),
    };
    expect(endScreenHold(path, "imessage:dm:+15555550100", deps)).toBe("none");
    expect(signalled).toEqual([]);
    expect(endScreenHold(path, "imessage:dm:+15555550101", deps)).toBe("signalled");
    expect(signalled).toEqual([4242]);
  });

  test("a holder that exited, or a pid now used by something else, just has its lock cleared", () => {
    const signalled: number[] = [];
    const signal = (p: number) => signalled.push(p);
    hold("a", 4242);
    expect(endScreenHold(path, "a", { alive: () => false, isServer: () => true, signal })).toBe(
      "cleared",
    );
    hold("a", 4243);
    expect(endScreenHold(path, "a", { alive: () => true, isServer: () => false, signal })).toBe(
      "cleared",
    );
    expect(signalled).toEqual([]);
    expect(new ScreenLock({ path, session: "b", pid: 1, alive: () => true }).acquire()).toBeNull();
  });

  test("against real processes: an unrelated pid is never signalled, a computer-use server is", async () => {
    const config = ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
      paths: { data_dir: dir },
    });
    const bystander = Bun.spawn(["sleep", "30"]);
    const server = Bun.spawn([
      "sh",
      "-c",
      'trap "exit 7" USR2; while :; do sleep 0.05; done',
      "src/mcp/computer-use/server.ts",
    ]);
    try {
      hold("imessage:dm:+15555550101", bystander.pid);
      releaseScreen(config, "imessage:dm:+15555550101");
      expect(existsSync(path)).toBe(false);
      expect(bystander.killed || bystander.exitCode !== null).toBe(false);

      hold("imessage:dm:+15555550101", server.pid);
      await Bun.sleep(200); // let the shell install its trap
      releaseScreen(config, "imessage:dm:+15555550101");
      expect(await server.exited).toBe(7);
    } finally {
      bystander.kill();
      server.kill();
    }
  });
});

// ─── The Jev guard, against a fake decisions endpoint ────────────────────

const allLow = (): Record<string, { type: string; noul: number }> =>
  Object.fromEntries(Object.keys(HARMS).map((h) => [h, { type: "noul", noul: 0.1 }]));

function jevResponse(overrides: Record<string, number> = {}, status = 200): Response {
  const answers = allLow();
  for (const [h, p] of Object.entries(overrides)) answers[h] = { type: "noul", noul: p };
  return new Response(JSON.stringify({ answers, usage: { input_tokens: 1000, cost: 0.00004 } }), {
    status,
  });
}

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const CHECK: Check = {
  tool: "left_click",
  action: 'left-click checkbox "Eggs" in Notes, window "Kitchen list"',
  app: "Notes",
  window: "Kitchen list",
  explanation: WHY,
};

function jev(
  fetchFn: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof JevGuard>[0]> = {},
) {
  const audit: AuditEntry[] = [];
  const guard = new JevGuard({
    apiKey: "sk-or-test",
    model: "typesafe/jev-1.13",
    threshold: 0.5,
    mode: "enforce",
    session: "imessage:dm:+15555550100",
    context: { requester: "Alex Rivera, the owner of this Mac" },
    request: () => ["Alex Rivera: tick eggs off my list"],
    audit: (e) => audit.push(e),
    fetch: fetchFn,
    sleep: async () => {},
    ...overrides,
  });
  return { guard, audit };
}

describe("JevGuard", () => {
  test("asks every harm question about the action, the request and the explanation", async () => {
    const { fn, calls } = fakeFetch([jevResponse()]);
    const { guard } = jev(fn);
    const v = await guard.check({ ...CHECK, facts: { note_open: "Kitchen list: theirs" } });
    expect(v.allowed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(body.questions).sort()).toEqual(Object.keys(HARMS).sort());
    for (const q of Object.values(body.questions) as Array<{ type: string }>) {
      expect(q.type).toBe("noul");
    }
    expect(body.state).toEqual({
      requester: "Alex Rivera, the owner of this Mac",
      request: "Alex Rivera: tick eggs off my list",
      frontmost_app: "Notes",
      window: "Kitchen list",
      note_open: "Kitchen list: theirs",
      action: CHECK.action,
      model_explanation: WHY,
    });
  });

  test("refuses when any harm reaches the threshold, naming the worst first", async () => {
    const { fn } = fakeFetch([jevResponse({ security: 0.62, session: 0.91 })]);
    const v = await jev(fn).guard.check(CHECK);
    expect(v.allowed).toBe(false);
    expect(v.flagged.map((f) => f.harm)).toEqual(["session", "security"]);
    expect(refusalText(v)).toContain("end or interrupt the Mac's session");
  });

  test("a score at the threshold is refused, one just under it is allowed", async () => {
    const at = fakeFetch([jevResponse({ privacy: 0.5 })]);
    expect((await jev(at.fn).guard.check(CHECK)).allowed).toBe(false);
    const under = fakeFetch([jevResponse({ privacy: 0.49 })]);
    expect((await jev(under.fn).guard.check(CHECK)).allowed).toBe(true);
  });

  test("retries overload and network failures, then answers", async () => {
    const { fn, calls } = fakeFetch([
      new Response("{}", { status: 529 }),
      new Error("socket hang up"),
      jevResponse(),
    ]);
    const v = await jev(fn).guard.check(CHECK);
    expect(v.allowed).toBe(true);
    expect(calls).toHaveLength(3);
    expect(v.attempts).toHaveLength(3);
    expect(v.attempts![0]).toMatch(/^HTTP 529 after \d+\.\ds$/);
    expect(v.attempts![1]).toMatch(/^no answer after \d+\.\ds: socket hang up$/);
    expect(v.attempts![2]).toMatch(/^HTTP 200 after /);
  });

  test("an unreachable classifier refuses the action", async () => {
    const { fn, calls } = fakeFetch(
      Array.from({ length: 4 }, () => new Response("{}", { status: 529 })),
    );
    const v = await jev(fn).guard.check(CHECK);
    expect(v.allowed).toBe(false);
    expect(v.error).toContain("529");
    expect(calls).toHaveLength(4);
    expect(refusalText(v)).toContain("could not run");
  });

  test("a rejected request is not retried and refuses", async () => {
    const { fn, calls } = fakeFetch([new Response("{}", { status: 400 })]);
    const v = await jev(fn).guard.check(CHECK);
    expect(v.allowed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("an answer missing any harm refuses", async () => {
    const { money: _, ...answers } = allLow();
    const { fn } = fakeFetch([new Response(JSON.stringify({ answers }))]);
    const v = await jev(fn).guard.check(CHECK);
    expect(v.allowed).toBe(false);
    expect(v.error).toContain("money");
  });

  test("shadow mode lets everything through but records what it would refuse", async () => {
    const { fn } = fakeFetch([jevResponse({ credentials: 0.9 })]);
    const { guard, audit } = jev(fn, { mode: "shadow" });
    expect((await guard.check(CHECK)).allowed).toBe(true);
    await guard.drain();
    expect(audit[0]!.mode).toBe("shadow");
    expect(audit[0]!.verdict.allowed).toBe(true);
    expect(audit[0]!.verdict.wouldDeny).toBe(true);
    expect(audit[0]!.verdict.flagged[0]!.harm).toBe("credentials");
  });

  test("in shadow mode the action does not wait for the verdict; in enforce mode it does", async () => {
    let answer: (r: Response) => void = () => {};
    const slow = (async () =>
      new Promise<Response>((r) => {
        answer = r;
      })) as unknown as typeof fetch;

    const shadow = jev(slow, { mode: "shadow" });
    expect((await shadow.guard.check(CHECK)).allowed).toBe(true);
    expect(shadow.audit).toHaveLength(0);
    answer(jevResponse());
    await shadow.guard.drain();
    expect(shadow.audit).toHaveLength(1);

    const enforce = jev(slow);
    let decided = false;
    const pending = enforce.guard.check(CHECK).then(() => {
      decided = true;
    });
    await Bun.sleep(10);
    expect(decided).toBe(false);
    answer(jevResponse());
    await pending;
    expect(decided).toBe(true);
  });

  test("every verdict is audited with the request it was judged against", async () => {
    const { fn } = fakeFetch([jevResponse()]);
    const { guard, audit } = jev(fn);
    await guard.check(CHECK);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.request).toEqual(["Alex Rivera: tick eggs off my list"]);
    expect(audit[0]!.explanation).toBe(WHY);
  });

  test("a turn started by a scheduled event says so, and the audit keeps it", async () => {
    const { fn, calls } = fakeFetch([jevResponse(), jevResponse()]);
    const event = "A scheduled event started this turn, not a new message: [Kitchen · Home] ...";
    const { guard, audit } = jev(fn, { startedBy: () => event });
    await guard.check(CHECK);
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.state.turn_started_by).toBe(event);
    expect(sent.questions.scope.instructions).toContain("turn_started_by");
    // Measured: without this, a scheduled sync's deletion of a stale line
    // scored destructive 0.54 even with the line named; with it, 0.29-0.38.
    expect(sent.questions.destructive.instructions).toContain(
      "deleting a line above its sentinel that is not one of those lines is the edit it asks for",
    );
    expect(audit[0]!.startedBy).toBe(event);

    const plain = jev(fn, { startedBy: () => null });
    await plain.guard.check(CHECK);
    expect(JSON.parse(calls[1]!.init.body as string).state).not.toHaveProperty("turn_started_by");
  });

  test("a failing trigger reader leaves the trigger out and still checks", async () => {
    const { fn, calls } = fakeFetch([jevResponse()]);
    const { guard } = jev(fn, {
      startedBy: () => {
        throw new Error("cron.db locked");
      },
    });
    expect((await guard.check(CHECK)).allowed).toBe(true);
    expect(JSON.parse(calls[0]!.init.body as string).state).not.toHaveProperty("turn_started_by");
  });

  test("a failing request reader still lets the check run, without a request", async () => {
    const { fn, calls } = fakeFetch([jevResponse()]);
    const { guard } = jev(fn, {
      request: () => {
        throw new Error("chat.db locked");
      },
    });
    expect((await guard.check(CHECK)).allowed).toBe(true);
    expect(JSON.parse(calls[0]!.init.body as string).state.request).toBe("(not available)");
  });
});

// ─── Session, against a fake screen and a fake check ─────────────────────

type Call = { op: string; args: unknown[] };

const INPUT_OPS = [
  "click",
  "move",
  "buttonDown",
  "buttonUp",
  "drag",
  "scroll",
  "chord",
  "type",
  "open",
];

const NOTE_ROWS = ["Sam and Alex's Kitchen list", "Jordan's Kitchen list", "A Small Poem"];
const CONVERSATION_ROWS = [
  "Alex Rivera, Tonight: stir-fry",
  "Sam, Unread, draw us a heart",
  "Alex,  Sam,  Casey & Morgan, Seven for seven",
  "Jordan Rivera, Makes sense",
];
const NOTES_WINDOW = { x: 600, y: 270, width: 1000, height: 660 };
const MESSAGES_WINDOW = { x: 360, y: 100, width: 1360, height: 660 };
const NOTE_BODY = { x: 1030, y: 326, width: 570, height: 600 };
const CONVERSATION_LIST = { x: 375, y: 112, width: 337, height: 639 };

/** Notes with one note open, the way the helper's inspect reports it. */
function notesView(open: string): Inspection {
  return {
    running: true,
    windows: [
      {
        title: "Notes",
        frame: NOTES_WINDOW,
        found: {
          [IDS.noteBody]: { value: `${open}\nEggs\nMilk`, rows: [], frame: NOTE_BODY },
          [IDS.noteBodyScroll]: { value: "", rows: [], frame: NOTE_BODY },
          [IDS.noteList]: {
            value: "",
            frame: { x: 830, y: 325, width: 200, height: 600 },
            rows: NOTE_ROWS.map((text, i) => ({
              text,
              frame: { x: 830, y: 336 + 56 * i, width: 200, height: 56 },
            })),
          },
        },
      },
    ],
  };
}

/** Messages with one conversation open. */
function messagesView(showing: string): Inspection {
  return {
    running: true,
    windows: [
      {
        title: showing,
        frame: MESSAGES_WINDOW,
        found: {
          [IDS.conversationList]: {
            value: "",
            frame: CONVERSATION_LIST,
            rows: CONVERSATION_ROWS.map((text, i) => ({
              text,
              frame: { x: 385, y: 200 + 80 * i, width: 317, height: 80 },
            })),
          },
        },
      },
    ],
  };
}

class FakeScreen implements Native {
  calls: Call[] = [];
  views: Record<string, Inspection> = {
    "com.apple.Notes": notesView("Sam and Alex's Kitchen list"),
    "com.apple.MobileSMS": messagesView("Alex Rivera"),
  };
  perms = { screenRecording: true, accessibility: true, locked: false };
  displayList: Display[] = [DISPLAY];
  front: RunningApp | null = app("com.apple.Notes", "Notes");
  owner: PointOwner = {
    pid: 1,
    bundleId: "com.apple.Notes",
    name: "Notes",
    role: "AXCheckBox",
    label: "Eggs",
    window: "Kitchen list",
  };
  focus: PointOwner | null = {
    pid: 1,
    bundleId: "com.apple.Notes",
    name: "Notes",
    role: "AXTextArea",
    label: "Note body",
    window: "Kitchen list",
  };
  apps: RunningApp[] = [
    app("com.apple.Notes", "Notes"),
    app("com.apple.Terminal", "Terminal"),
    app("com.google.Chrome", "Google Chrome"),
    app("com.apple.finder", "Finder"),
    { ...app("com.apple.UserNotificationCenter", "UserNotificationCenter"), regular: false },
  ];
  clipboard: string | null = "before";

  private log(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
  }
  ops() {
    return this.calls.map((c) => c.op);
  }
  input() {
    return this.calls.filter((c) => INPUT_OPS.includes(c.op));
  }

  async permissions() {
    return this.perms;
  }
  async displays() {
    return this.displayList;
  }
  async frontmost() {
    return this.front;
  }
  async running() {
    return this.apps;
  }
  async ownerAt(x: number, y: number) {
    this.log("ownerAt", x, y);
    return this.owner;
  }
  async focused() {
    return this.focus;
  }
  async inspect(bundleId: string, _ids: string[]) {
    return this.views[bundleId] ?? { running: false, windows: [] };
  }
  async hide(ids: string[]) {
    this.log("hide", ids);
    return ids.map((id) => this.apps.find((a) => a.bundleId === id)?.name ?? id);
  }
  async installedApps() {
    return APPS;
  }
  /** Brings a running app forward, or launches it with a new pid, as LaunchServices does. */
  async open(bundleId: string) {
    this.log("open", bundleId);
    const running = this.apps.find((a) => a.bundleId === bundleId);
    if (running) return running;
    const launched = {
      ...app(bundleId, APPS.find((a) => a.bundleId === bundleId)?.name ?? bundleId),
      pid: this.nextPid++,
    };
    this.apps.push(launched);
    return launched;
  }
  /** Apps that stop to ask about unsaved work instead of quitting. */
  asksToSave = new Set<string>();
  private nextPid = 5000;
  async quit(targets: Array<{ pid: number; bundleId: string }>): Promise<QuitResult> {
    this.log(
      "quit",
      targets.map((t) => t.pid),
    );
    const result: QuitResult = { quit: [], stillOpen: [] };
    for (const t of targets) {
      const found = this.apps.find((a) => a.pid === t.pid && a.bundleId === t.bundleId);
      if (!found) continue;
      if (this.asksToSave.has(t.bundleId)) {
        result.stillOpen.push(found.name);
        continue;
      }
      this.apps = this.apps.filter((a) => a !== found);
      result.quit.push(found.name);
    }
    return result;
  }
  /** An app launched by something other than this session's own actions. */
  launch(bundleId: string, name: string): RunningApp {
    const launched = { ...app(bundleId, name), pid: this.nextPid++ };
    this.apps.push(launched);
    return launched;
  }
  quitCalls(): number[][] {
    return this.calls.filter((c) => c.op === "quit").map((c) => c.args[0] as number[]);
  }
  async capture(opts: CaptureOptions): Promise<Capture> {
    this.log("capture", opts);
    return { data: "AAAA", width: opts.width, height: opts.height };
  }
  async cursor() {
    return { x: 960, y: 540 };
  }
  async click(x: number, y: number, button: Button, count: number, flags: number) {
    this.log("click", x, y, button, count, flags);
  }
  async move(x: number, y: number, held: Button | null) {
    this.log("move", x, y, held);
  }
  async buttonDown(b: Button) {
    this.log("buttonDown", b);
  }
  async buttonUp(b: Button) {
    this.log("buttonUp", b);
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    this.log("drag", from, to);
  }
  async scroll(x: number, y: number, dx: number, dy: number, flags: number) {
    this.log("scroll", x, y, dx, dy, flags);
  }
  async chord(chord: Chord, opts?: { repeat?: number; holdMs?: number }) {
    this.log("chord", chord, opts);
  }
  async type(text: string) {
    this.log("type", text);
  }
  async clipboardRead() {
    this.log("clipboardRead");
    return this.clipboard;
  }
  async clipboardWrite(text: string) {
    this.log("clipboardWrite", text);
    this.clipboard = text;
  }
}

/** Allows everything unless told otherwise, and remembers what it was asked. */
class FakeGuard implements Guard {
  checks: Check[] = [];
  refuse: ((c: Check) => boolean) | null = null;
  async check(c: Check): Promise<Verdict> {
    this.checks.push(c);
    if (this.refuse?.(c)) {
      return {
        allowed: false,
        flagged: [{ harm: "security", p: 0.9 }],
        scores: { security: 0.9 },
        ms: 1,
      };
    }
    return { allowed: true, flagged: [], scores: {}, ms: 1 };
  }
}

/** A running app; the same bundle id always has the same pid unless relaunched. */
function app(bundleId: string, name: string): RunningApp {
  if (!PIDS.has(bundleId)) PIDS.set(bundleId, 100 + PIDS.size);
  return { bundleId, name, pid: PIDS.get(bundleId)!, hidden: false, regular: true };
}
const PIDS = new Map<string, number>();

const POLICY: Policy = {
  tier: "operator",
  apps: ["Notes", "Messages", "Finder", "Google Chrome", "Terminal"],
  clipboard: true,
  systemKeyCombos: true,
};

const OTHER_LISTS = ["Jordan's Kitchen list", "Casey's shopping list"];
const ALEX: Scope = {
  requester: "Alex Rivera, the owner of this Mac",
  conversation: { kind: "dm", name: "Alex Rivera", handle: "+15555550100" },
  ownNotes: ["Sam and Alex's Kitchen list"],
  otherNotes: OTHER_LISTS,
};
const SAM: Scope = {
  requester: "Sam, a contact who texts Edmund (not the owner of this Mac)",
  conversation: { kind: "dm", name: "Sam", handle: "+15555550101" },
  ownNotes: ["Sam and Alex's Kitchen list"],
  otherNotes: OTHER_LISTS,
};
const HOUSE_GROUP: Scope = {
  ...SAM,
  requester: "a member of the group chat",
  conversation: {
    kind: "group",
    name: null,
    members: ["Alex Rivera", "Sam", "Casey Lin", "Morgan"],
  },
};
const CONTACT: Policy = {
  tier: "contact",
  apps: ["Messages", "Notes", "Maps"],
  clipboard: false,
  systemKeyCombos: false,
};

/** Time that moves only when the code under test sleeps; `onSleep` runs at each new time. */
function fakeClock(onSleep?: (t: number) => Promise<void> | void) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      await onSleep?.(t);
    },
  };
}

function setup(
  policy: Policy = POLICY,
  lock: ScreenLock | null = null,
  scope: Scope = ALEX,
  clock = fakeClock(),
) {
  const screen = new FakeScreen();
  const guard = new FakeGuard();
  const session = new ComputerSession({
    native: screen,
    policy,
    scope,
    guard,
    lock,
    sleep: clock.sleep,
    now: clock.now,
  });
  return { screen, guard, session, clock };
}

const text = (r: ToolResult) =>
  r.content.map((c) => (c.type === "text" ? c.text : "[image]")).join(" ");

async function ready(apps = ["Notes"], policy: Policy = POLICY, scope: Scope = ALEX) {
  const s = setup(policy, null, scope);
  await s.session.requestAccess({ apps, reason: "test" });
  await s.session.single({ action: "screenshot" });
  s.screen.calls = [];
  return s;
}

const act = (a: Action): Action => ({ explanation: WHY, ...a });

describe("request_access", () => {
  test("goes by the approved apps as they stand when asked, and says what they are", async () => {
    let approvedNow = ["Notes"];
    const session = new ComputerSession({
      native: new FakeScreen(),
      policy: POLICY,
      scope: ALEX,
      guard: new FakeGuard(),
      lock: null,
      approvedApps: () => approvedNow,
    });
    const first = JSON.parse(await session.requestAccess({ apps: ["Maps"], reason: "t" }));
    expect(first.denied).toEqual([{ app: "Maps", reason: "not approved for this conversation" }]);
    expect(first.approvedApps).toEqual(["Notes"]);
    approvedNow = ["Notes", "Maps"];
    const second = JSON.parse(await session.requestAccess({ apps: ["Maps"], reason: "t" }));
    expect(second.granted.map((g: { bundleId: string }) => g.bundleId)).toEqual(["com.apple.Maps"]);
    expect(JSON.parse(session.listGranted()).approvedApps).toEqual(["Notes", "Maps"]);
  });

  test("grants approved apps and says why the rest were denied", async () => {
    const { session } = setup();
    const out = JSON.parse(
      await session.requestAccess({ apps: ["notes", "Maps", "Nonexistent"], reason: "test" }),
    );
    expect(out.granted.map((g: { bundleId: string }) => g.bundleId)).toEqual(["com.apple.Notes"]);
    expect(out.denied).toEqual([
      { app: "Maps", reason: "not approved for this conversation" },
      { app: "Nonexistent", reason: "not installed" },
    ]);
  });

  test("grant flags need both the request and the policy", async () => {
    const { session } = setup({ ...POLICY, clipboard: false, systemKeyCombos: false });
    const out = JSON.parse(
      await session.requestAccess({
        apps: ["Notes"],
        reason: "t",
        clipboardRead: true,
        systemKeyCombos: true,
      }),
    );
    expect(out.grantFlags).toEqual({
      clipboardRead: false,
      clipboardWrite: false,
      systemKeyCombos: false,
    });
  });

  test("a browser is granted read-only and says so", async () => {
    const { session } = setup();
    const out = JSON.parse(await session.requestAccess({ apps: ["Google Chrome"], reason: "t" }));
    expect(out.granted[0].tier).toBe("read");
    expect(out.notes[0]).toContain("visible in screenshots only");
  });
});

describe("screenshot", () => {
  test("refuses until something is granted, and captures nothing", async () => {
    const { session, screen } = setup();
    const r = await session.single({ action: "screenshot" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("request_access");
    expect(screen.ops()).not.toContain("capture");
  });

  test("hides and excludes ungranted apps, but not Finder or system agents", async () => {
    const { session, screen, guard } = setup();
    await session.requestAccess({ apps: ["Notes"], reason: "t" });
    const r = await session.single({ action: "screenshot" });
    expect(r.isError).toBeUndefined();
    const hidden = screen.calls.find((c) => c.op === "hide")!.args[0];
    expect(hidden).toEqual(["com.apple.Terminal", "com.google.Chrome"]);
    const capture = screen.calls.find((c) => c.op === "capture")!.args[0] as CaptureOptions;
    expect(capture.exclude).toEqual([
      "com.apple.Terminal",
      "com.google.Chrome",
      "com.apple.finder",
    ]);
    expect(capture.include).toBeUndefined();
    expect(capture.width).toBe(1460);
    expect(text(r)).toContain('"Terminal", "Google Chrome" were open and got hidden');
    expect(r.content.some((c) => c.type === "image")).toBe(true);
    // Looking is not checked.
    expect(guard.checks).toEqual([]);
  });

  test("a contact's screenshot shows only granted apps, so no banner or dialog can leak", async () => {
    const contact: Policy = {
      tier: "contact",
      apps: ["Maps"],
      clipboard: false,
      systemKeyCombos: false,
    };
    const { session, screen } = setup(contact);
    await session.requestAccess({ apps: ["Maps", "Notes"], reason: "t" });
    await session.single({ action: "screenshot" });
    const capture = screen.calls.find((c) => c.op === "capture")!.args[0] as CaptureOptions;
    expect(capture.include).toEqual(["com.apple.Maps"]);
  });

  test("says which permission is missing instead of capturing", async () => {
    const { session, screen } = setup();
    screen.perms = { screenRecording: false, accessibility: true, locked: false };
    await session.requestAccess({ apps: ["Notes"], reason: "t" });
    const r = await session.single({ action: "screenshot" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Screen & System Audio Recording");
    expect(screen.ops()).not.toContain("capture");
  });
});

describe("clicks", () => {
  test("coordinates are screenshot pixels, scaled to points", async () => {
    const { session, screen } = await ready();
    const r = await session.single(act({ action: "left_click", coordinate: [730, 410.5] }));
    expect(r.isError).toBeUndefined();
    expect(screen.input()).toEqual([{ op: "click", args: [960, 540, "left", 1, 0] }]);
  });

  test("the safety check sees the element, the app and the explanation before the click", async () => {
    const { session, guard } = await ready();
    await session.single(act({ action: "left_click", coordinate: [100, 100] }));
    expect(guard.checks).toEqual([
      {
        tool: "left_click",
        action: 'left-click checkbox "Eggs" in Notes, window "Kitchen list"',
        app: "Notes",
        window: "Kitchen list",
        explanation: WHY,
        facts: { note_open: "Sam and Alex's Kitchen list: the requester's household list" },
      },
    ]);
  });

  test("a refused check sends nothing and tells the model not to retry", async () => {
    const { session, screen, guard } = await ready();
    guard.refuse = () => true;
    const r = await session.single(act({ action: "left_click", coordinate: [100, 100] }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Blocked by the safety check");
    expect(text(r)).toContain("Do not retry");
    expect(screen.input()).toEqual([]);
  });

  test("need a screenshot first", async () => {
    const { session, screen } = setup();
    await session.requestAccess({ apps: ["Notes"], reason: "t" });
    const r = await session.single(act({ action: "left_click", coordinate: [10, 10] }));
    expect(text(r)).toContain("Take a screenshot first");
    expect(screen.input()).toEqual([]);
  });

  test("are refused off the edge of the screenshot", async () => {
    const { session, screen } = await ready();
    const r = await session.single(act({ action: "left_click", coordinate: [1500, 10] }));
    expect(text(r)).toContain("outside the last screenshot");
    expect(screen.input()).toEqual([]);
  });

  test("are refused when the frontmost app is not granted", async () => {
    const { session, screen, guard } = await ready();
    screen.front = app("com.apple.Terminal", "Terminal");
    const r = await session.single(act({ action: "left_click", coordinate: [100, 100] }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"Terminal" is frontmost and is not granted');
    expect(screen.input()).toEqual([]);
    expect(guard.checks).toEqual([]);
  });

  test("are refused when an ungranted app owns the point, even with a granted app in front", async () => {
    const { session, screen } = await ready();
    screen.owner = {
      pid: 9,
      bundleId: "com.apple.UserNotificationCenter",
      name: "UserNotificationCenter",
      role: "AXButton",
    };
    const r = await session.single(act({ action: "left_click", coordinate: [100, 100] }));
    expect(text(r)).toContain("covered by UserNotificationCenter");
    expect(screen.input()).toEqual([]);
  });

  test("the Dock and the desktop need Finder", async () => {
    const { session, screen } = await ready();
    screen.owner = { pid: 2, bundleId: "com.apple.dock", name: "Dock", role: "AXDockItem" };
    const refused = await session.single(act({ action: "left_click", coordinate: [100, 800] }));
    expect(text(refused)).toContain("Finder (the Dock)");
    expect(screen.input()).toEqual([]);

    await session.requestAccess({ apps: ["Finder"], reason: "t" });
    const ok = await session.single(act({ action: "left_click", coordinate: [100, 800] }));
    expect(ok.isError).toBeUndefined();
    expect(screen.input().map((c) => c.op)).toEqual(["click"]);
  });

  test("a browser in front is look-only", async () => {
    const { session, screen } = await ready(["Notes", "Google Chrome"]);
    screen.front = app("com.google.Chrome", "Google Chrome");
    screen.owner = {
      pid: 3,
      bundleId: "com.google.Chrome",
      name: "Google Chrome",
      role: "AXWebArea",
    };
    const r = await session.single(act({ action: "left_click", coordinate: [100, 100] }));
    expect(text(r)).toContain("visible in screenshots only");
    expect(screen.input()).toEqual([]);
  });

  test("a terminal can be left-clicked but not typed into, right-clicked or modifier-clicked", async () => {
    const { session, screen } = await ready(["Notes", "Terminal"]);
    screen.front = app("com.apple.Terminal", "Terminal");
    screen.owner = { pid: 4, bundleId: "com.apple.Terminal", name: "Terminal", role: "AXTextArea" };
    const click = await session.single(act({ action: "left_click", coordinate: [10, 10] }));
    expect(click.isError).toBeUndefined();
    expect((await session.single(act({ action: "type", text: "rm -rf" }))).isError).toBe(true);
    const right = await session.single(act({ action: "right_click", coordinate: [10, 10] }));
    expect(right.isError).toBe(true);
    const modified = await session.single(
      act({ action: "left_click", coordinate: [10, 10], text: "cmd" }),
    );
    expect(modified.isError).toBe(true);
    expect(screen.input().map((c) => c.op)).toEqual(["click"]);
  });

  test("nothing is sent while the Mac is locked, but it can still be looked at", async () => {
    const { session, screen, guard } = await ready();
    screen.perms = { ...screen.perms, locked: true };
    const r = await session.single(act({ action: "left_click", coordinate: [100, 100] }));
    expect(text(r)).toContain("The Mac is locked");
    expect(screen.input()).toEqual([]);
    expect(guard.checks).toEqual([]);
    const shot = await session.single({ action: "screenshot" });
    expect(text(shot)).toContain("The Mac is locked");
  });
});

describe("pointer", () => {
  test("hovering is not checked, but moving with the button held is", async () => {
    const { session, guard } = await ready();
    await session.single(act({ action: "mouse_move", coordinate: [100, 100] }));
    expect(guard.checks).toEqual([]);
    await session.single(act({ action: "left_mouse_down" }));
    await session.single(act({ action: "mouse_move", coordinate: [200, 200] }));
    await session.single(act({ action: "left_mouse_up" }));
    expect(guard.checks.map((c) => c.tool)).toEqual([
      "left_mouse_down",
      "mouse_move",
      "left_mouse_up",
    ]);
    expect(guard.checks[1]!.action).toStartWith("drag, with the left button held");
  });

  test("a drag is judged by both ends", async () => {
    const { session, guard } = await ready();
    await session.single(
      act({ action: "left_click_drag", start_coordinate: [10, 10], coordinate: [200, 200] }),
    );
    expect(guard.checks[0]!.action).toBe(
      'drag from checkbox "Eggs" in Notes, window "Kitchen list" to checkbox "Eggs" in Notes, window "Kitchen list"',
    );
  });
});

describe("keyboard", () => {
  test("shortcuts go to the check with their meaning and the focused field", async () => {
    const { session, guard } = await ready();
    await session.requestAccess({ apps: [], reason: "t", systemKeyCombos: true });
    await session.single(act({ action: "key", text: "cmd+q" }));
    expect(guard.checks[0]!.action).toBe(
      'press key chord cmd+q (macOS shortcut: Quit Notes) with focus on text area "Note body" in Notes, window "Kitchen list"',
    );
  });

  test("session-ending shortcuts are refused before the check, even with the system grant", async () => {
    const { session, screen, guard } = await ready();
    for (const chord of ["ctrl+cmd+q", "cmd+shift+q", "cmd+alt+escape"]) {
      const r = await session.single(act({ action: "key", text: chord }));
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("Edmund never does that");
    }
    expect(screen.input()).toEqual([]);
    expect(guard.checks).toEqual([]);
  });

  test("quitting Messages is refused outright", async () => {
    const { session, screen } = await ready(["Notes", "Messages"]);
    screen.front = app("com.apple.MobileSMS", "Messages");
    const r = await session.single(act({ action: "key", text: "cmd+q" }));
    expect(text(r)).toContain("quits Messages");
    expect(screen.input()).toEqual([]);
  });

  test("system combos need their own grant", async () => {
    const { session, screen } = await ready(["Notes"], { ...POLICY, systemKeyCombos: false });
    const r = await session.single(act({ action: "key", text: "cmd+tab" }));
    expect(text(r)).toContain("systemKeyCombos");
    expect(screen.input()).toEqual([]);
    expect((await session.single(act({ action: "key", text: "cmd+s" }))).isError).toBeUndefined();
    expect(screen.input().map((c) => c.op)).toEqual(["chord"]);
  });

  test("nothing is typed or pasted into a password field, and the check is never asked", async () => {
    const { session, screen, guard } = await ready();
    screen.focus = {
      ...screen.focus!,
      role: "AXTextField",
      subrole: "AXSecureTextField",
      secure: true,
    };
    expect(text(await session.single(act({ action: "type", text: "s3cret-pass" })))).toContain(
      "password field",
    );
    expect(text(await session.single(act({ action: "key", text: "cmd+v" })))).toContain(
      "password field",
    );
    expect(screen.input()).toEqual([]);
    expect(guard.checks).toEqual([]);
    // Other keys in a password field (Tab to move on) are fine.
    expect((await session.single(act({ action: "key", text: "Tab" }))).isError).toBeUndefined();
  });

  test("typed text goes to the check", async () => {
    const { session, guard } = await ready();
    await session.single(act({ action: "type", text: "Milk" }));
    expect(guard.checks[0]!.action).toBe(
      'type text "Milk" into text area "Note body" in Notes, window "Kitchen list"',
    );
  });

  test("multi-line text pastes through the clipboard and puts the old text back", async () => {
    const { session, screen } = await ready();
    await session.requestAccess({ apps: [], reason: "t", clipboardWrite: true });
    const r = await session.single(act({ action: "type", text: "line one\nline two" }));
    expect(text(r)).toBe("Typed (via clipboard).");
    const writes = screen.calls.filter((c) => c.op === "clipboardWrite").map((c) => c.args[0]);
    expect(writes).toEqual(["line one\nline two", "before"]);
    expect(screen.ops()).not.toContain("type");
  });

  test("without the clipboard grant, text is typed key by key", async () => {
    const { session, screen } = await ready();
    await session.single(act({ action: "type", text: "a\nb" }));
    expect(screen.input()).toEqual([{ op: "type", args: ["a\nb"] }]);
  });
});

describe("apps and clipboard", () => {
  test("opening an app is checked", async () => {
    const { session, screen, guard } = await ready(["Notes", "Messages"]);
    guard.refuse = (c) => c.tool === "open_application";
    const r = await session.openApplication("Messages", WHY);
    expect(r.isError).toBe(true);
    expect(screen.input()).toEqual([]);
    expect(guard.checks[0]!.action).toBe('open the application "Messages"');
  });

  test("clipboard reads and writes are checked", async () => {
    const { session, guard } = await ready();
    await session.requestAccess({
      apps: [],
      reason: "t",
      clipboardRead: true,
      clipboardWrite: true,
    });
    await session.readClipboard(WHY);
    await session.writeClipboard("eggs", WHY);
    expect(guard.checks.map((c) => c.tool)).toEqual(["read_clipboard", "write_clipboard"]);
  });
});

describe("computer_batch", () => {
  test("coordinates refer to the screenshot before the batch, even after one inside it", async () => {
    const { session, screen } = await ready();
    // The display changes size mid-batch; the click must still use the old frame.
    screen.displayList = [{ ...DISPLAY, width: 1000, height: 500, scale: 1 }];
    const r = await session.batch(
      [{ action: "screenshot" }, { action: "left_click", coordinate: [730, 410.5] }],
      WHY,
    );
    expect(r.isError).toBeUndefined();
    expect(screen.input()).toEqual([{ op: "click", args: [960, 540, "left", 1, 0] }]);
    // Afterwards the batch's screenshot is the reference.
    await session.single(act({ action: "left_click", coordinate: [500, 250] }));
    expect(screen.input()[1]).toEqual({ op: "click", args: [500, 250, "left", 1, 0] });
  });

  test("the batch's explanation is checked with each action", async () => {
    const { session, guard } = await ready();
    await session.batch(
      [
        { action: "left_click", coordinate: [10, 10] },
        { action: "type", text: "Milk" },
      ],
      WHY,
    );
    expect(guard.checks.map((c) => c.explanation)).toEqual([WHY, WHY]);
  });

  test("stops at the first failure and says how much did not run", async () => {
    const { session, screen } = await ready();
    const r = await session.batch(
      [
        { action: "left_click", coordinate: [10, 10] },
        { action: "key", text: "ctrl+cmd+q" },
        { action: "type", text: "never" },
        { action: "key", text: "Return" },
      ],
      WHY,
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("[2/4] key:");
    expect(text(r)).toContain("2 action(s) not run");
    expect(screen.input().map((c) => c.op)).toEqual(["click"]);
  });
});

describe("the screen lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-cu-session-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a second conversation waits while the first is acting, and goes as soon as its turn ends", async () => {
    const path = join(dir, "screen.lock");
    const alive = () => true;
    const first = setup(POLICY, new ScreenLock({ path, session: "a", pid: 1, alive }));
    const clock = fakeClock(async (t) => {
      if (t === 5_000) await first.session.endHold();
    });
    const second = setup(
      POLICY,
      new ScreenLock({ path, session: "b", pid: 2, alive }),
      ALEX,
      clock,
    );
    for (const s of [first, second]) {
      await s.session.requestAccess({ apps: ["Notes"], reason: "t" });
    }
    expect((await first.session.single({ action: "screenshot" })).isError).toBeUndefined();
    const r = await second.session.single({ action: "screenshot" });
    expect(r.isError).toBeUndefined();
    expect(second.screen.ops()).toContain("capture");
    expect(clock.now()).toBe(5_000);
    // And now the first has to wait for the second.
    expect(new ScreenLock({ path, session: "a", pid: 1, alive }).heldByOther()).toBe(true);
  });

  test("gives up after the wait, touching nothing, and says the screen is busy", async () => {
    const path = join(dir, "screen.lock");
    const alive = () => true;
    const first = setup(POLICY, new ScreenLock({ path, session: "a", pid: 1, alive }));
    const second = setup(POLICY, new ScreenLock({ path, session: "b", pid: 2, alive }));
    for (const s of [first, second]) {
      await s.session.requestAccess({ apps: ["Notes"], reason: "t" });
    }
    await first.session.single({ action: "screenshot" });
    const r = await second.session.single({ action: "screenshot" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Another conversation");
    expect(text(r)).toContain("screen is busy");
    expect(second.clock.now()).toBe(SCREEN_WAIT_MS);
    expect(second.screen.ops()).not.toContain("capture");
  });
});

describe("closing what a turn opened", () => {
  const MAPS = "com.apple.Maps";
  const WITH_MAPS: Policy = { ...POLICY, apps: [...POLICY.apps, "Maps"] };

  async function holding(apps = ["Notes", "Maps", "Messages"]) {
    const s = setup(WITH_MAPS);
    await s.session.requestAccess({ apps, reason: "test" });
    await s.session.single({ action: "screenshot" });
    return s;
  }

  test("an app the turn opened is quit when the turn ends; one already running is left open", async () => {
    const { session, screen } = await holding();
    await session.openApplication("Maps", WHY);
    await session.openApplication("Notes", WHY);
    const maps = screen.apps.find((a) => a.bundleId === MAPS)!;
    const ended = await session.endHold();
    expect(screen.quitCalls()).toEqual([[maps.pid]]);
    expect(ended).toEqual({ quit: ["Maps"], stillOpen: [] });
    expect(screen.apps.some((a) => a.bundleId === "com.apple.Notes")).toBe(true);
  });

  test("a granted app that appeared during the turn is quit too; an ungranted one is not touched", async () => {
    const { session, screen } = await holding();
    const maps = screen.launch(MAPS, "Maps");
    screen.launch("com.example.Other", "Other");
    await session.single({ action: "screenshot" });
    await session.endHold();
    expect(screen.quitCalls()).toEqual([[maps.pid]]);
  });

  test("Messages is never quit, even when the turn launched it", async () => {
    const { session, screen } = await holding();
    screen.apps = screen.apps.filter((a) => a.bundleId !== "com.apple.MobileSMS");
    await session.openApplication("Messages", WHY);
    await session.endHold();
    expect(screen.quitCalls()).toEqual([]);
  });

  test("an app that stops to ask about unsaved work is left open and reported", async () => {
    const { session, screen } = await holding();
    screen.asksToSave.add(MAPS);
    await session.openApplication("Maps", WHY);
    expect(await session.endHold()).toEqual({ quit: [], stillOpen: ["Maps"] });
  });

  test("nothing is quit out from under a conversation that took the screen after this one went idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-cu-idle-"));
    try {
      const path = join(dir, "screen.lock");
      let t = 0;
      const now = () => t;
      const alive = () => true;
      const first = setup(WITH_MAPS, new ScreenLock({ path, session: "a", pid: 1, now, alive }));
      await first.session.requestAccess({ apps: ["Maps"], reason: "t" });
      await first.session.openApplication("Maps", WHY);
      t = HOLD_IDLE_MS + 1;
      expect(new ScreenLock({ path, session: "b", pid: 2, now, alive }).acquire()).toBeNull();
      expect(await first.session.endHold()).toEqual({ quit: [], stillOpen: ["Maps"] });
      expect(first.screen.quitCalls()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("after the turn, the old screenshot's coordinates are no longer accepted", async () => {
    const { session, screen } = await holding();
    await session.endHold();
    const r = await session.single(act({ action: "left_click", coordinate: [100, 100] }));
    expect(text(r)).toContain("Take a screenshot first");
    expect(screen.input()).toEqual([]);
  });

  test("a turn that never touched the screen has nothing to end", async () => {
    const s = setup(WITH_MAPS);
    await s.session.requestAccess({ apps: ["Maps"], reason: "t" });
    expect(await s.session.endHold()).toBeNull();
  });
});

// ─── Scope: whose conversation, whose list ───────────────────────────────

/** Screen points to pixels in the 1460x821 screenshot of the 1920x1080 display. */
const px = (x: number, y: number): number[] => [(x * 1460) / 1920, (y * 821) / 1080];
const messagesApp = app("com.apple.MobileSMS", "Messages");
const inMessages = (o: Partial<PointOwner> = {}): PointOwner => ({
  pid: 5,
  bundleId: "com.apple.MobileSMS",
  name: "Messages",
  role: "AXTextArea",
  ...o,
});

describe("scope matching", () => {
  test("a DM is known by the contact's name, or by the number when there is no card", () => {
    const dm = { kind: "dm" as const, name: "Jordan  Rivera", handle: "+15555550100" };
    expect(isConversation(dm, "Jordan Rivera")).toBe(true);
    expect(isConversation(dm, "jordan rivera")).toBe(true);
    expect(isConversation(dm, "+1 (555) 555-0100")).toBe(true);
    expect(isConversation(dm, "Jordan")).toBe(false);
    expect(isConversation(dm, "Sam")).toBe(false);
    expect(isConversation(null, "Sam")).toBe(false);
  });

  test("an unnamed group is known by exactly its members' first names", () => {
    const group = HOUSE_GROUP.conversation;
    expect(isConversation(group, "Alex,  Sam,  Casey & Morgan")).toBe(true);
    expect(isConversation(group, "Sam, Morgan, Alex & Casey")).toBe(true);
    expect(isConversation(group, "Alex & Sam")).toBe(false);
    expect(isConversation(group, "Alex, Sam, Casey, Morgan & Jocelyn")).toBe(false);
    const named = { kind: "group" as const, name: "The House", members: ["Sam"] };
    expect(isConversation(named, "The House")).toBe(true);
  });

  test("a sidebar row is matched on its title, whatever the preview says", () => {
    expect(isConversationRow(SAM.conversation, "Sam, Unread, draw us a heart")).toBe(true);
    expect(isConversationRow(SAM.conversation, "Alex Rivera, Sam said hi")).toBe(false);
    expect(
      isConversationRow(HOUSE_GROUP.conversation, "Alex,  Sam,  Casey & Morgan, Seven for seven"),
    ).toBe(true);
    expect(isConversationRow(HOUSE_GROUP.conversation, "Sam, Unread, draw us a heart")).toBe(false);
  });

  test("nobody edits another household's list; a contact edits only their own", () => {
    expect(noteRefusal(ALEX, "operator", "Jordan's Kitchen list")).toContain("another household");
    expect(noteRefusal(ALEX, "operator", "Sam and Alex's Kitchen list")).toBeNull();
    expect(noteRefusal(ALEX, "operator", "A Small Poem")).toBeNull();
    expect(noteRefusal(SAM, "contact", "A Small Poem")).toContain("not this household's list");
    expect(noteRefusal(SAM, "contact", "sam and alex's kitchen list")).toBeNull();
    expect(noteRefusal(SAM, "contact", "Jordan's Kitchen list")).toContain("another household");
  });

  test("the classifier is told who asked, from where, and whose lists are whose", () => {
    expect(guardContext(SAM)).toEqual({
      requester: "Sam, a contact who texts Edmund (not the owner of this Mac)",
      conversation: "the request came from the DM between Edmund and Sam",
      requester_household_list: '"Sam and Alex\'s Kitchen list"',
      other_households_lists: '"Jordan\'s Kitchen list", "Casey\'s shopping list"',
    });
  });
});

describe("what a contact's screenshot hides", () => {
  test("in Messages: every other conversation's row, and the open one if it is not theirs", () => {
    const own = redactions(SAM, "com.apple.MobileSMS", messagesView("Sam"));
    expect(own).toHaveLength(3);
    expect(own.every((r) => r.x === 385)).toBe(true);
    const other = redactions(SAM, "com.apple.MobileSMS", messagesView("Alex Rivera"));
    expect(other).toHaveLength(4);
    expect(other[3]).toEqual({ x: 712, y: 100, width: 1008, height: 660 });
  });

  test("in Notes: every other note's row, and the open note if it is not theirs", () => {
    expect(
      redactions(SAM, "com.apple.Notes", notesView("Sam and Alex's Kitchen list")),
    ).toHaveLength(2);
    const other = redactions(SAM, "com.apple.Notes", notesView("Jordan's Kitchen list"));
    expect(other).toHaveLength(3);
    expect(other[2]).toEqual(NOTE_BODY);
  });

  test("a window it cannot make sense of is hidden whole", () => {
    const odd: Inspection = {
      running: true,
      windows: [{ title: "?", frame: NOTES_WINDOW, found: {} }],
    };
    expect(redactions(SAM, "com.apple.Notes", odd)).toEqual([NOTES_WINDOW]);
    expect(redactions(SAM, "com.apple.MobileSMS", odd)).toEqual([NOTES_WINDOW]);
  });

  test("an app whose windows cannot be read is left out of a contact's capture", async () => {
    // What the Notes accessibility tree looks like while the Mac is locked.
    const blank: Inspection = { running: true, windows: [{ title: "Notes", found: {} }] };
    expect(redactions(SAM, "com.apple.Notes", blank)).toBeNull();
    const contact = setup(CONTACT, null, SAM);
    await contact.session.requestAccess({ apps: ["Notes", "Maps"], reason: "t" });
    contact.screen.views["com.apple.Notes"] = blank;
    const r = await contact.session.single({ action: "screenshot" });
    const shot = contact.screen.calls.find((c) => c.op === "capture")!.args[0] as CaptureOptions;
    expect(shot.include).toEqual(["com.apple.Maps"]);
    expect(text(r)).toContain("Notes could not be checked");
  });

  test("a contact's capture carries the redactions; the operator's does not", async () => {
    const contact = setup(CONTACT, null, SAM);
    await contact.session.requestAccess({ apps: ["Messages", "Notes"], reason: "t" });
    contact.screen.apps.push(messagesApp);
    contact.screen.views["com.apple.MobileSMS"] = messagesView("Sam");
    await contact.session.single({ action: "screenshot" });
    const shot = contact.screen.calls.find((c) => c.op === "capture")!.args[0] as CaptureOptions;
    expect(shot.include?.sort()).toEqual(["com.apple.MobileSMS", "com.apple.Notes"]);
    expect(shot.redact).toHaveLength(3 + 2);

    const owner = setup(POLICY, null, ALEX);
    await owner.session.requestAccess({ apps: ["Messages", "Notes"], reason: "t" });
    await owner.session.single({ action: "screenshot" });
    const mine = owner.screen.calls.find((c) => c.op === "capture")!.args[0] as CaptureOptions;
    expect(mine.redact).toEqual([]);
  });
});

describe("Messages is scoped to the conversation the request came from", () => {
  async function inMessagesAs(scope: Scope, showing: string, policy: Policy = CONTACT) {
    const s = await ready(["Messages", "Notes"], policy, scope);
    s.screen.front = messagesApp;
    s.screen.owner = inMessages({ label: "iMessage", window: showing });
    s.screen.focus = inMessages({ label: "iMessage", window: showing });
    s.screen.views["com.apple.MobileSMS"] = messagesView(showing);
    return s;
  }

  test("acting in the requester's own conversation goes to the check, saying so", async () => {
    const { session, screen, guard } = await inMessagesAs(SAM, "Sam");
    const r = await session.single(act({ action: "type", text: "❤️" }));
    expect(r.isError).toBeUndefined();
    expect(screen.input().map((c) => c.op)).toEqual(["type"]);
    expect(guard.checks[0]!.facts).toEqual({
      messages_showing: "Sam: the requester's own conversation, checked against chat.db",
    });
  });

  test("acting in anyone else's conversation is refused before the check", async () => {
    const { session, screen, guard } = await inMessagesAs(SAM, "Alex Rivera");
    const r = await session.single(act({ action: "type", text: "❤️" }));
    expect(text(r)).toContain('Messages is showing "Alex Rivera"');
    expect(screen.input()).toEqual([]);
    expect(guard.checks).toEqual([]);
  });

  test("the operator is held to his own conversation too", async () => {
    const { session, screen } = await inMessagesAs(ALEX, "Sam", POLICY);
    const r = await session.single(act({ action: "type", text: "on my way" }));
    expect(text(r)).toContain("which is not the DM between Edmund and Alex Rivera");
    expect(screen.input()).toEqual([]);
  });

  test("the requester's own row may be clicked to get there; nobody else's", async () => {
    const { session, screen } = await inMessagesAs(SAM, "Alex Rivera");
    screen.owner = inMessages({ role: "AXStaticText", label: CONVERSATION_ROWS[1] });
    const mine = await session.single(act({ action: "left_click", coordinate: px(400, 300) }));
    expect(mine.isError).toBeUndefined();
    const theirs = await session.single(act({ action: "left_click", coordinate: px(400, 220) }));
    expect(text(theirs)).toContain("That row is a different conversation");
    expect(screen.input()).toHaveLength(1);
  });

  test("a key goes to the conversation window, not a popover Messages puts in front of it", async () => {
    const { session, screen } = await inMessagesAs(SAM, "Sam");
    const main = messagesView("Sam").windows[0]!;
    const popover = { title: "", frame: { x: 900, y: 600, width: 200, height: 60 }, found: {} };
    screen.views["com.apple.MobileSMS"] = { running: true, windows: [popover, main] };
    const r = await session.single(act({ action: "key", text: "Return" }));
    expect(r.isError).toBeUndefined();
    expect(screen.input().map((c) => c.op)).toEqual(["chord"]);
  });

  test("searching is allowed from anywhere", async () => {
    const { session, screen } = await inMessagesAs(SAM, "Alex Rivera");
    screen.focus = inMessages({ role: "AXTextField", subrole: "AXSearchField", label: "Search" });
    const r = await session.single(act({ action: "type", text: "Sam" }));
    expect(r.isError).toBeUndefined();
  });

  test("an unnamed group is recognised by its members", async () => {
    const { session, screen } = await inMessagesAs(HOUSE_GROUP, "Alex,  Sam,  Casey & Morgan");
    await session.single(act({ action: "type", text: "🎉" }));
    expect(screen.input().map((c) => c.op)).toEqual(["type"]);
  });

  test("a request that came from no conversation cannot act in Messages at all", async () => {
    const { session, screen } = await inMessagesAs(
      { ...ALEX, conversation: null },
      "Alex Rivera",
      POLICY,
    );
    const r = await session.single(act({ action: "type", text: "hi" }));
    expect(text(r)).toContain("did not come from a conversation");
    expect(screen.input()).toEqual([]);
  });
});

describe("Notes is scoped to the requester's household list", () => {
  async function inNotesAs(scope: Scope, open: string, policy: Policy = CONTACT) {
    const s = await ready(["Notes"], policy, scope);
    s.screen.views["com.apple.Notes"] = notesView(open);
    return s;
  }

  test("a contact edits their own household's list", async () => {
    const { session, screen, guard } = await inNotesAs(SAM, "Sam and Alex's Kitchen list");
    expect((await session.single(act({ action: "type", text: "Eggs" }))).isError).toBeUndefined();
    expect(screen.input().map((c) => c.op)).toEqual(["type"]);
    expect(guard.checks[0]!.facts).toEqual({
      note_open: "Sam and Alex's Kitchen list: the requester's household list",
    });
  });

  test("a contact cannot edit another household's list, or the owner's own notes", async () => {
    for (const open of ["Jordan's Kitchen list", "A Small Poem"]) {
      const { session, screen, guard } = await inNotesAs(SAM, open);
      const r = await session.single(act({ action: "type", text: "Eggs" }));
      expect(r.isError).toBe(true);
      expect(screen.input()).toEqual([]);
      expect(guard.checks).toEqual([]);
    }
  });

  test("a contact can open their own list from the note list, and no other", async () => {
    const { session, screen } = await inNotesAs(SAM, "Sam and Alex's Kitchen list");
    const own = await session.single(act({ action: "left_click", coordinate: px(900, 360) }));
    expect(own.isError).toBeUndefined();
    const jordan = await session.single(act({ action: "left_click", coordinate: px(900, 420) }));
    expect(text(jordan)).toContain("\"Jordan's Kitchen list\" is not this household's list");
    expect(screen.input()).toHaveLength(1);
  });

  test("a key goes to the window holding the note, not a small window Notes puts in front of it", async () => {
    const { session, screen, guard } = await inNotesAs(SAM, "Sam and Alex's Kitchen list");
    const main = notesView("Sam and Alex's Kitchen list").windows[0]!;
    // With several checklist lines selected, Notes lists a small untitled window first.
    const popup = { title: "", frame: { x: 1100, y: 400, width: 44, height: 28 }, found: {} };
    screen.views["com.apple.Notes"] = { running: true, windows: [popup, main] };
    screen.focus = { ...screen.focus!, window: "Notes" };
    const r = await session.single(act({ action: "key", text: "delete" }));
    expect(r.isError).toBeUndefined();
    expect(screen.input().map((c) => c.op)).toEqual(["chord"]);
    expect(guard.checks[0]!.facts).toEqual({
      note_open: "Sam and Alex's Kitchen list: the requester's household list",
    });
  });

  test("with two notes open, the one being typed in decides, so another household's is still refused", async () => {
    const { session, screen, guard } = await inNotesAs(SAM, "Sam and Alex's Kitchen list");
    const own = notesView("Sam and Alex's Kitchen list").windows[0]!;
    const theirs = {
      ...notesView("Jordan's Kitchen list").windows[0]!,
      title: "Jordan's Kitchen list",
    };
    screen.views["com.apple.Notes"] = { running: true, windows: [own, theirs] };
    screen.focus = { ...screen.focus!, window: "Jordan's Kitchen list" };
    const r = await session.single(act({ action: "key", text: "delete" }));
    expect(text(r)).toContain("another household's list");
    expect(screen.input()).toEqual([]);
    expect(guard.checks).toEqual([]);
  });

  test("a delete is described by the text it removes, and typing over a selection by what it replaces", async () => {
    const { session, screen, guard } = await inNotesAs(SAM, "Sam and Alex's Kitchen list");
    screen.focus = {
      ...screen.focus!,
      selection: { location: 40, length: 0 },
      selectedText: "",
      textBefore: "Sam and Alex's Kitchen list\nLimes, 8",
      textAfter: "\nAvocados, 2, a little firm\nTortilla chips",
    };
    await session.single(act({ action: "key", text: "forward_delete", repeat: 27 }));
    expect(guard.checks.at(-1)!.action).toContain(
      'which deletes this text: "⏎Avocados, 2, a little firm"',
    );
    screen.focus = {
      ...screen.focus!,
      selection: { location: 30, length: 8 },
      selectedText: "Limes, 8",
    };
    await session.single(act({ action: "type", text: "Limes, 6" }));
    expect(guard.checks.at(-1)!.action).toContain('replacing the selected text "Limes, 8"');
  });

  test("nothing is typed when Notes cannot say which note is open", async () => {
    const { session, screen, guard } = await inNotesAs(ALEX, "A Small Poem", POLICY);
    screen.views["com.apple.Notes"] = { running: true, windows: [{ title: "Notes", found: {} }] };
    const r = await session.single(act({ action: "type", text: "Eggs" }));
    expect(text(r)).toContain("did not say which note is open");
    expect(screen.input()).toEqual([]);
    expect(guard.checks).toEqual([]);
  });

  test("the operator writes his own notes, but never another household's list", async () => {
    const poem = await inNotesAs(ALEX, "A Small Poem", POLICY);
    await poem.session.single(act({ action: "type", text: "a third stanza" }));
    expect(poem.guard.checks[0]!.facts).toEqual({
      note_open: "A Small Poem: the owner's own note, not a household list",
    });
    const jordan = await inNotesAs(ALEX, "Jordan's Kitchen list", POLICY);
    const r = await jordan.session.single(act({ action: "type", text: "Eggs" }));
    expect(text(r)).toContain("another household's list");
    expect(jordan.screen.input()).toEqual([]);
  });
});

// ─── Published interface ─────────────────────────────────────────────────

/**
 * Tool names, parameters and required fields of Claude Code's built-in
 * computer-use server (2.1.280). A model that has learned that server should
 * be able to call this one; the one addition is the explanation every tool
 * requires for the safety check.
 */
const BUILT_IN: Record<string, { props: string[]; required: string[] }> = {
  request_access: {
    props: ["apps", "reason", "clipboardRead", "clipboardWrite", "systemKeyCombos"],
    required: ["apps", "reason"],
  },
  screenshot: { props: [], required: [] },
  zoom: { props: ["region"], required: ["region"] },
  left_click: { props: ["coordinate", "text"], required: ["coordinate"] },
  double_click: { props: ["coordinate", "text"], required: ["coordinate"] },
  triple_click: { props: ["coordinate", "text"], required: ["coordinate"] },
  right_click: { props: ["coordinate", "text"], required: ["coordinate"] },
  middle_click: { props: ["coordinate", "text"], required: ["coordinate"] },
  type: { props: ["text"], required: ["text"] },
  key: { props: ["text", "repeat"], required: ["text"] },
  scroll: {
    props: ["coordinate", "scroll_direction", "scroll_amount"],
    required: ["coordinate", "scroll_direction", "scroll_amount"],
  },
  left_click_drag: { props: ["coordinate", "start_coordinate"], required: ["coordinate"] },
  mouse_move: { props: ["coordinate"], required: ["coordinate"] },
  open_application: { props: ["app"], required: ["app"] },
  switch_display: { props: ["display"], required: ["display"] },
  list_granted_applications: { props: [], required: [] },
  read_clipboard: { props: [], required: [] },
  write_clipboard: { props: ["text"], required: ["text"] },
  wait: { props: ["duration"], required: ["duration"] },
  cursor_position: { props: [], required: [] },
  hold_key: { props: ["text", "duration"], required: ["text", "duration"] },
  left_mouse_down: { props: [], required: [] },
  left_mouse_up: { props: [], required: [] },
  computer_batch: { props: ["actions"], required: ["actions"] },
};

describe("published schemas", () => {
  const { session } = setup();
  const tools = computerTools(session);
  const schemas = new Map(
    tools.map((t) => [t.name, zodToJsonSchema(t.inputSchema, t.name) as Record<string, unknown>]),
  );

  test("the same 24 tools as the built-in server", () => {
    expect([...schemas.keys()].sort()).toEqual(Object.keys(BUILT_IN).sort());
  });

  test("the built-in's parameters, plus a required explanation on every tool", () => {
    for (const [name, want] of Object.entries(BUILT_IN)) {
      const s = schemas.get(name)!;
      const props = Object.keys((s.properties as Record<string, unknown>) ?? {});
      expect({ name, props: props.sort() }).toEqual({
        name,
        props: [...want.props, "explanation"].sort(),
      });
      expect({ name, required: [...((s.required as string[]) ?? [])].sort() }).toEqual({
        name,
        required: [...want.required, "explanation"].sort(),
      });
      const explanation = (s.properties as Record<string, Record<string, unknown>>).explanation!;
      expect({ name, minLength: explanation.minLength }).toEqual({
        name,
        minLength: MIN_EXPLANATION,
      });
    }
  });

  test("every tool rejects a short explanation before anything runs", () => {
    for (const t of tools) {
      const parsed = t.inputSchema.safeParse({ explanation: "too short" });
      const flagged = parsed.success
        ? false
        : parsed.error.issues.some((i) => i.path.join(".") === "explanation");
      expect({ name: t.name, flagged }).toEqual({ name: t.name, flagged: true });
    }
  });

  test("coordinates are exactly two numbers, as the built-in publishes them", () => {
    const click = schemas.get("left_click")!.properties as Record<string, Record<string, unknown>>;
    expect(click.coordinate).toMatchObject({
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "number" },
    });
    const batch = schemas.get("computer_batch")!.properties as Record<
      string,
      Record<string, unknown>
    >;
    const item = (batch.actions!.items as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(item.action!.enum).toHaveLength(17);
    expect(item.scroll_amount).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
  });

  test("no description names the approved apps: a resumed conversation would keep a stale list", () => {
    const odd = setup({ ...POLICY, apps: ["Zebra Paint", "Quokka Notes"] }).session;
    for (const t of computerTools(odd)) {
      expect(t.description).not.toContain("Zebra Paint");
      expect(t.description).not.toContain("Quokka Notes");
    }
  });
});

describe("MCP config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edmund-cu-mcp-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const servers = (path: string) =>
    Object.keys((JSON.parse(readFileSync(path, "utf8")) as { mcpServers: object }).mcpServers);

  test("enabled: every operator and contact loadout gets the server, guests never do", () => {
    const config = ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
      computer_use: { enabled: true, apps: ["Notes"] },
    });
    config.paths.data_dir = dir;
    const paths = ensureMcpConfig(config);
    expect(servers(paths.default)).toContain("computer");
    expect(servers(paths.withBrowser)).toContain("computer");
    expect(servers(paths.trading)).toContain("computer");
    expect(servers(paths.guest)).toEqual(["edmund-harness"]);
    // Claude Code drops a configured server named after its built-in one.
    expect(servers(paths.default)).not.toContain("computer-use");
  });

  test("disabled: no server at all", () => {
    const config = ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
    });
    config.paths.data_dir = dir;
    expect(servers(ensureMcpConfig(config).default)).not.toContain("computer");
  });
});
