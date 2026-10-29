/**
 * After every compaction, automatic or manual, a SessionStart hook puts the
 * chat's latest messages back, verbatim, because a summary keeps pointers and
 * not words (on 2026-10-26 it kept a draft's path instead of the post the operator
 * published). Recall excludes the same window, so both read it through
 * recentThreadWindow.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST_COMPACT_THREAD_CHARS, recentThreadWindow } from "../src/channels/history.ts";
import { isolatedSettingsArgs, postCompactHookSettings } from "../src/claude/direct-env.ts";
import { postCompactContext } from "../src/claude/post-compact-thread.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const GUID = "any;-;+15550100031";
const H = "+15550100031";
const now = Date.now();
const nsAt = (ms: number) => (ms - 978_307_200_000) * 1_000_000;
const HOUR = 3_600_000;

// Ten messages an hour apart, alternating sides; the newest is an hour old.
const rows = Array.from({ length: 10 }, (_, i) => ({
  fromMe: i % 2,
  text: `message ${i} ${"x".repeat(40)}`,
  ms: now - (10 - i) * HOUR,
}));
const db = emptyChatDb();
{
  const w = new Database(db.path);
  // chatGuidsForSession finds a DM's chats by style 45 and its handles.
  w.exec("ALTER TABLE chat ADD COLUMN style INTEGER");
  w.exec(
    `INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES (1, '${GUID}', '${H}', 45)`,
  );
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (1, '${H}', 'iMessage')`);
  w.exec("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)");
  rows.forEach((r, i) => {
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, associated_message_type) VALUES (${i + 1}, 'G${i + 1}', '${r.text}', ${r.fromMe ? 0 : 1}, ${r.fromMe}, ${nsAt(r.ms)}, 0)`,
    );
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ${i + 1})`);
  });
  w.close();
}
const chatDb = new ChatDb(db.path);
afterAll(() => {
  chatDb.close();
  db.cleanup();
});

const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  behavior: { history_messages: 6 },
});
const contacts = { displayName: () => null, label: () => null } as unknown as ContactBook;
const deps = { config, chatDb, contacts, state: null };
const key = `imessage:dm:${H}` as never;

describe("recentThreadWindow", () => {
  test("reads the latest history_messages, oldest first", () => {
    const { lines } = recentThreadWindow(key, GUID, deps);
    expect(lines.map((l) => l.text.split(" ").slice(0, 2).join(" "))).toEqual([
      "message 4",
      "message 5",
      "message 6",
      "message 7",
      "message 8",
      "message 9",
    ]);
  });

  test("reads the thread as it stood before a moment", () => {
    const { lines } = recentThreadWindow(key, GUID, deps, { beforeMs: now - 3.5 * HOUR });
    expect(lines.at(-1)!.text.startsWith("message 6")).toBe(true);
    expect(lines).toHaveLength(6);
  });

  test("drops the oldest lines until the rendered text fits the budget", () => {
    const full = recentThreadWindow(key, GUID, deps);
    const lastTwo = full.formatted.slice(-2).reduce((n, f) => n + f.length + 1, 0);
    const fit = recentThreadWindow(key, GUID, deps, { budgetChars: lastTwo + 5 });
    expect(fit.formatted).toHaveLength(2);
    expect(fit.lines.at(-1)!.text.startsWith("message 9")).toBe(true);
    expect(fit.lines[0]!.text.startsWith("message 8")).toBe(true);
  });
});

describe("the hook's output", () => {
  test("says the lines are verbatim and outrank the summary, then gives them", () => {
    const text = postCompactContext(["  You: a", "  Them: b"]);
    expect(text.split("\n").slice(1)).toEqual(["  You: a", "  Them: b"]);
    expect(text).toContain("exactly as they were sent");
    expect(text).toContain("these are right");
    expect(postCompactContext([])).toBe("");
    expect(POST_COMPACT_THREAD_CHARS).toBeGreaterThan(0);
  });
});

describe("the worker's settings", () => {
  test("register the hook on compaction and keep every isolation setting", () => {
    const argv = isolatedSettingsArgs(postCompactHookSettings("/usr/local/bin/bun"));
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.alwaysThinkingEnabled).toBe(true);
    const [entry] = settings.hooks.SessionStart;
    expect(entry.matcher).toBe("compact");
    const command: string = entry.hooks[0].command;
    const script = command.match(/"([^"]+post-compact-thread\.ts)"/)?.[1];
    expect(command.startsWith('"/usr/local/bin/bun" ')).toBe(true);
    expect(script && existsSync(script)).toBe(true);
  });
});

// One run of the real hook entry point, against the fixture chat.db, the way
// the CLI runs it: environment in, JSON on stdout.
describe("the hook process", () => {
  test("prints the window as SessionStart additionalContext", async () => {
    const dir = mkdtempSync(join(tmpdir(), "post-compact-"));
    try {
      const cfg = join(dir, "config.toml");
      await Bun.write(
        cfg,
        `[self]\nhandles = []\n[allowlist]\n[identity]\n[paths]\nchat_db = "${db.path}"\ndata_dir = "${dir}"\n[behavior]\nhistory_messages = 4\n[[contacts]]\nname = "Test Person"\nhandles = ["${H}"]\n`,
      );
      const script = join(import.meta.dir, "../src/claude/post-compact-thread.ts");
      const r = Bun.spawnSync([process.execPath, script], {
        env: {
          ...process.env,
          EDMUND_SESSION_KEY: key,
          EDMUND_CONFIG_PATH: cfg,
          EDMUND_DATA_DIR: dir,
        },
        stdin: new TextEncoder().encode('{"hook_event_name":"SessionStart","source":"compact"}'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).toBe("");
      const out = JSON.parse(r.stdout.toString());
      expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
      const lines: string[] = out.hookSpecificOutput.additionalContext.split("\n").slice(1);
      expect(lines).toHaveLength(4);
      expect(lines.at(-1)).toContain("message 9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
