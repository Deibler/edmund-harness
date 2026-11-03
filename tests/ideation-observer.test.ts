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

  test("a disabled section admits nobody even when people are listed", () => {
    expect(
      eligible(config({ enabled: false, people: [PERSON] }), contacts, `imessage:dm:${PERSON}`),
    ).toBe(false);
  });
});

describe("IdeationObserver.runIfDue, before any model is called", () => {
  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), "ideation-obs-"));
    const chatPath = join(dataDir, "chat.db");
    const w = new Database(chatPath);
    w.exec("PRAGMA journal_mode = WAL");
    w.exec(
      "CREATE TABLE message (ROWID INTEGER PRIMARY KEY); CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);",
    );
    w.close();
    const store = new IdeationStore(dataDir);
    const obs = new IdeationObserver(
      {
        config: config({ enabled: true, people: [PERSON] }, dataDir),
        chatDb: new ChatDb(chatPath),
        contacts,
        store,
        agents: new AgentStore(dataDir),
      },
      60_000,
    );
    return { store, obs };
  }
  const key = `imessage:dm:${PERSON}`;
  const NOW = Date.parse("2026-11-03T14:00:00-05:00");

  test("one pass a day per person", async () => {
    const { store, obs } = setup();
    store.recordRun({
      sessionKey: key,
      ranMs: NOW - RUN_INTERVAL_MS + 60_000,
      outcome: "none",
      detail: "",
      costUsd: 0.1,
    });
    expect(await obs.runIfDue(key, NOW)).toBe("ran recently");
  });

  test("no pass in a week that already had a build for them, and the skip is recorded", async () => {
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
    expect(await obs.runIfDue(key, NOW)).toContain("built for them in the last 7 days");
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
});
