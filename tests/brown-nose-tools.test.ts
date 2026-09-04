/**
 * Tests for the brown-nose MCP tools. Each test constructs a fake
 * ToolContext pointed at a temp data dir + sandbox, invokes the tool
 * handler, and asserts the side effect (prefs row state) is what we
 * expect.
 *
 * `loadToolContext` reads env + opens real DBs; we bypass it by
 * building a minimal ToolContext directly.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BgJobStore } from "../src/background/store.ts";
import { loadConfig } from "../src/config/config.ts";
import { CronStore } from "../src/cron/store.ts";
import { DEFAULT_ACTIVE_HOURS_DM, GhostPrefsStore } from "../src/ghost/prefs.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { ToolContext } from "../src/mcp/context.ts";
import { brownNoseTools } from "../src/mcp/tools/brown-nose.ts";
import { AddressBook } from "../src/sessions/address-book.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const JORDAN: SessionKey = "imessage:dm:+19995550042" as SessionKey;

function setup(): {
  ctx: ToolContext;
  prefs: GhostPrefsStore;
  cleanup: () => void;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "edmund-bn-tools-"));
  const sandboxPath = join(dataDir, "sandbox");
  const config = loadConfig();
  const chatDb = new ChatDb(emptyChatDb().path);
  const contacts = new ContactBook([], new AddressBook());
  const cron = new CronStore(dataDir);
  const bgJobs = new BgJobStore(dataDir);
  const prefs = new GhostPrefsStore(dataDir);

  const ctx: ToolContext = {
    config,
    cron,
    chatDb,
    contacts,
    sessionKey: JORDAN,
    chatGuids: [],
    sandboxPath,
    dataDir,
    bgJobs,
  };
  return {
    ctx,
    prefs,
    cleanup: () => {
      prefs.close();
      cron.close?.();
      chatDb.close?.();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function findTool(ctx: ToolContext, name: string) {
  const tool = brownNoseTools(ctx).find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

describe("set_brown_nose", () => {
  test("creates a prefs row for a new session with the supplied fields", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const tool = findTool(ctx, "set_brown_nose");
      await tool.handler({ enabled: true, weekly_cap: 5, timezone: "Europe/London" });
      const row = prefs.get(JORDAN);
      expect(row).not.toBeNull();
      expect(row!.enabled).toBe(true);
      expect(row!.weeklyCap).toBe(5);
      expect(row!.timezone).toBe("Europe/London");
      // active_hours must come from the canonical prefs.ts defaults —
      // the tool used to hand out the LEGACY M-F 9-19 arrays (and []
      // for groups, which made a group born via set_brown_nose
      // permanently unable to fire).
      expect(row!.activeHours).toEqual(DEFAULT_ACTIVE_HOURS_DM);
    } finally {
      cleanup();
    }
  });

  test("updates an existing row without losing untouched fields", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const tool = findTool(ctx, "set_brown_nose");
      await tool.handler({ weekly_cap: 5, timezone: "Europe/London" });
      await tool.handler({ weekly_cap: 7 }); // only weekly_cap changes
      const row = prefs.get(JORDAN)!;
      expect(row.weeklyCap).toBe(7);
      expect(row.timezone).toBe("Europe/London"); // preserved
    } finally {
      cleanup();
    }
  });

  test("active_hours can be set to empty to disable all windows", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const tool = findTool(ctx, "set_brown_nose");
      await tool.handler({ enabled: true, active_hours: [] });
      const row = prefs.get(JORDAN)!;
      expect(row.activeHours).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("disable_brown_nose + enable_brown_nose", () => {
  test("disable sets enabled=false and records the reason + timestamp", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const disable = findTool(ctx, "disable_brown_nose");
      await disable.handler({ reason: "user said stop in DM" });
      const row = prefs.get(JORDAN)!;
      expect(row.enabled).toBe(false);
      expect(row.disabledReason).toBe("user said stop in DM");
      expect(row.disabledAtMs).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("enable clears disabledReason + timestamp", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const disable = findTool(ctx, "disable_brown_nose");
      const enable = findTool(ctx, "enable_brown_nose");
      await disable.handler({ reason: "test" });
      await enable.handler({});
      const row = prefs.get(JORDAN)!;
      expect(row.enabled).toBe(true);
      expect(row.disabledReason).toBeNull();
      expect(row.disabledAtMs).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("add_focus_suggestion + clear_focus_suggestions", () => {
  test("add records a new topic with usageCount=0", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const add = findTool(ctx, "add_focus_suggestion");
      await add.handler({ topic: "software development", duration_days: 7 });
      const row = prefs.get(JORDAN)!;
      expect(row.focusSuggestions.length).toBe(1);
      expect(row.focusSuggestions[0]!.topic).toBe("software development");
      expect(row.focusSuggestions[0]!.usageCount).toBe(0);
      expect(row.focusSuggestions[0]!.expiresAtMs).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("add dedupes by topic (case-insensitive) — second add refreshes the same row", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const add = findTool(ctx, "add_focus_suggestion");
      await add.handler({ topic: "Hiking" });
      await add.handler({ topic: "hiking" });
      const row = prefs.get(JORDAN)!;
      expect(row.focusSuggestions.length).toBe(1);
      // Preserves the most recent casing.
      expect(row.focusSuggestions[0]!.topic).toBe("hiking");
    } finally {
      cleanup();
    }
  });

  test("clear empties the list", async () => {
    const { ctx, prefs, cleanup } = setup();
    try {
      const add = findTool(ctx, "add_focus_suggestion");
      const clear = findTool(ctx, "clear_focus_suggestions");
      await add.handler({ topic: "a" });
      await add.handler({ topic: "b" });
      await clear.handler({});
      const row = prefs.get(JORDAN)!;
      expect(row.focusSuggestions).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("ghost_status + query_ghost", () => {
  test("ghost_status returns a not-enrolled line when no prefs row exists", async () => {
    const { ctx, cleanup } = setup();
    try {
      const tool = findTool(ctx, "ghost_status");
      const res = (await tool.handler({})) as { content: Array<{ text: string }> };
      expect(res.content[0]!.text).toContain("not enrolled");
    } finally {
      cleanup();
    }
  });

  test("ghost_status includes weekly cap + intensity after enrollment", async () => {
    const { ctx, cleanup } = setup();
    try {
      await findTool(ctx, "set_brown_nose").handler({ enabled: true, weekly_cap: 4 });
      const res = (await findTool(ctx, "ghost_status").handler({})) as {
        content: Array<{ text: string }>;
      };
      expect(res.content[0]!.text).toContain("weekly cap: 4");
      expect(res.content[0]!.text).toContain("intensity");
    } finally {
      cleanup();
    }
  });

  test("query_ghost includes the question plus recent state", async () => {
    const { ctx, cleanup } = setup();
    try {
      await findTool(ctx, "set_brown_nose").handler({ enabled: true });
      const res = (await findTool(ctx, "query_ghost").handler({
        question: "why did you text me?",
      })) as { content: Array<{ text: string }> };
      const out = res.content[0]!.text;
      expect(out).toContain("question: why did you text me?");
      expect(out).toContain("brown-nose: on");
    } finally {
      cleanup();
    }
  });
});
