import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents/store.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { IdeationObserver, RUN_INTERVAL_MS, eligible } from "../src/ideation/observer.ts";
import { IdeationStore, newIdeationId } from "../src/ideation/store.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

const PERSON = "+15550100001";
const OTHER = "+15550100002";
const contacts = new ContactBook([]);

function config(
  ideation: Record<string, unknown>,
  dataDir = mkdtempSync(join(tmpdir(), "ideation-obs-")),
  access: "full" | "sandboxed" = "full",
) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    paths: { data_dir: dataDir },
    security: { model_host_access: access },
    ideation,
  });
}

describe("eligible", () => {
  test("off by default, and nobody when on with no people", () => {
    expect(eligible(config({}), contacts, `imessage:dm:${PERSON}`)).toBe(false);
    expect(eligible(config({ enabled: true }), contacts, `imessage:dm:${PERSON}`)).toBe(false);
  });

  test("only the configured people, only in one-to-one iMessage chats", () => {
    const c = config({ enabled: true, people: [PERSON] });
    expect(eligible(c, contacts, `imessage:dm:${PERSON}`)).toBe(true);
    expect(eligible(c, contacts, `imessage:dm:${OTHER}`)).toBe(false);
    expect(eligible(c, contacts, "imessage:group:any;+;chat123")).toBe(false);
    expect(eligible(c, contacts, `sms:dm:${PERSON}`)).toBe(false);
    expect(eligible(c, contacts, `orch:helper:imessage:dm:${PERSON}`)).toBe(false);
  });

  test("nobody where the model has no shell to build with", () => {
    const on = { enabled: true, people: [PERSON] };
    expect(eligible(config(on, undefined, "sandboxed"), contacts, `imessage:dm:${PERSON}`)).toBe(
      false,
    );
    expect(eligible(config(on, undefined, "full"), contacts, `imessage:dm:${PERSON}`)).toBe(true);
  });

  test('"*" admits every one-to-one iMessage chat, and still no guest', () => {
    const all = config({ enabled: true, people: ["*"] });
    expect(eligible(all, contacts, `imessage:dm:${PERSON}`)).toBe(true);
    expect(eligible(all, contacts, `imessage:dm:${OTHER}`)).toBe(true);
    expect(eligible(all, contacts, "imessage:group:any;+;chat123")).toBe(false);
    expect(eligible(all, contacts, `sms:dm:${PERSON}`)).toBe(false);
    expect(eligible(all, contacts, `orch:helper:imessage:dm:${PERSON}`)).toBe(false);
    const guest = (k: string) => k === `imessage:dm:${OTHER}`;
    expect(eligible(all, contacts, `imessage:dm:${PERSON}`, guest)).toBe(true);
    expect(eligible(all, contacts, `imessage:dm:${OTHER}`, guest)).toBe(false);
    // Listing a guest by name does not let them in either.
    const named = config({ enabled: true, people: [OTHER] });
    expect(eligible(named, contacts, `imessage:dm:${OTHER}`, guest)).toBe(false);
    expect(
      eligible(config({ enabled: false, people: ["*"] }), contacts, `imessage:dm:${PERSON}`),
    ).toBe(false);
  });

  test("a disabled section admits nobody even when people are listed", () => {
    expect(
      eligible(config({ enabled: false, people: [PERSON] }), contacts, `imessage:dm:${PERSON}`),
    ).toBe(false);
  });
});

describe("IdeationObserver.runIfDue, before any model is called", () => {
  function setup(people: string[] = [PERSON], isExcludedSession?: (sessionKey: string) => boolean) {
    const dataDir = mkdtempSync(join(tmpdir(), "ideation-obs-"));
    const chatPath = join(dataDir, "chat.db");
    const w = new Database(chatPath);
    w.exec("PRAGMA journal_mode = WAL");
    w.exec(
      `CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER,
         is_from_me INTEGER DEFAULT 0);
       CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
       CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
       CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
       CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);`,
    );
    w.close();
    const store = new IdeationStore(dataDir);
    const obs = new IdeationObserver(
      {
        config: config({ enabled: true, people }, dataDir),
        chatDb: new ChatDb(chatPath),
        contacts,
        store,
        agents: new AgentStore(dataDir),
        isExcludedSession,
      },
      60_000,
    );
    return { store, obs };
  }
  const key = `imessage:dm:${PERSON}`;
  const NOW = Date.parse("2026-11-03T14:00:00-05:00");

  test("a pass turned back by a gate looks again after a day", async () => {
    const { store, obs } = setup();
    store.recordRun({
      sessionKey: key,
      ranMs: NOW - RUN_INTERVAL_MS + 60_000,
      outcome: "skipped",
      detail: "",
      costUsd: null,
    });
    expect(await obs.runIfDue(key, NOW)).toBe("ran recently");
  });

  test("a pass that found nothing waits days, not hours, before the next look", async () => {
    const { store, obs } = setup();
    store.recordRun({
      sessionKey: key,
      ranMs: NOW - 30 * 3_600_000,
      outcome: "none",
      detail: "",
      costUsd: 0.2,
    });
    expect(await obs.runIfDue(key, NOW)).toBe("ran recently");
    // Six days on, past the longest wait, it may look again (and the empty
    // test chat.db gives it nothing to read).
    expect(await obs.runIfDue(key, NOW + 6 * 86_400_000)).not.toBe("ran recently");
  });

  test("no pass while a page for them is still being built, and the skip is recorded", async () => {
    const { store, obs } = setup();
    store.create({
      id: newIdeationId(),
      sessionKey: key,
      thread: "fishing",
      threadKey: "fishing",
      title: "River Map",
      pitch: "A map of the bends they fish.",
      why: "Asked on four days.",
      brief: "Build it.",
      evidence: [1, 2, 3],
      days: ["2026-10-30", "2026-10-31", "2026-11-01"],
      createdMs: NOW - 2 * 86_400_000,
    });
    expect(await obs.runIfDue(key, NOW)).toContain("a page for them is still being built");
    expect(store.lastRunMs(key)).toBe(NOW);
  });

  test("replies from someone not configured never arm a pass", () => {
    const { obs } = setup();
    obs.onMainReplied(`imessage:dm:${OTHER}`);
    expect((obs as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    obs.onMainReplied(key);
    expect((obs as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
    obs.stop();
  });

  test("with \"*\", anyone's reply arms a pass except a guest's", () => {
    const { obs } = setup(["*"], (k) => k === `imessage:dm:${OTHER}`);
    const pending = () => (obs as unknown as { pending: Map<string, unknown> }).pending;
    obs.onMainReplied(`imessage:dm:${OTHER}`);
    expect(pending().size).toBe(0);
    obs.onMainReplied(key);
    obs.onMainReplied("imessage:dm:+15550100003");
    expect([...pending().keys()]).toEqual([key, "imessage:dm:+15550100003"]);
    obs.stop();
  });
});
