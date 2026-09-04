import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RELAY_DEPTH,
  buildRelayEnvelope,
  parseInboundDepth,
  relativeAgo,
  relay,
} from "../src/bridge/relay.ts";
import type { Config } from "../src/config/config.ts";
import { CronStore } from "../src/cron/store.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import { normalizeHandle } from "../src/sessions/key.ts";
import { StateStore } from "../src/sessions/store.ts";

/**
 * In-memory chat.db stand-in. The ChatDb class wraps a bun:sqlite
 * connection — relay code only ever calls `chatDb.query()`, so we hand
 * back a duck-typed object that exposes the same `query<T>(sql).{all,get}`
 * interface against an in-memory schema we control.
 */
function buildFakeChatDb(seed: {
  handles: string[];
  groups: Array<{ guid: string; participants: string[]; displayName?: string | null }>;
}): ChatDb {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT,
      style INTEGER,
      display_name TEXT
    );
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT
    );
    CREATE TABLE chat_handle_join (
      chat_id INTEGER,
      handle_id INTEGER
    );
  `);
  const handleId = new Map<string, number>();
  for (const h of seed.handles) {
    db.query("INSERT INTO handle(id) VALUES (?)").run(h);
    handleId.set(h, db.query("SELECT last_insert_rowid() AS r").get()!.r as number);
  }
  for (const g of seed.groups) {
    db.query("INSERT INTO chat(guid, style, display_name) VALUES (?, 43, ?)").run(
      g.guid,
      g.displayName ?? null,
    );
    const cid = db.query("SELECT last_insert_rowid() AS r").get()!.r as number;
    for (const h of g.participants) {
      let hid = handleId.get(h);
      if (hid === undefined) {
        db.query("INSERT INTO handle(id) VALUES (?)").run(h);
        hid = db.query("SELECT last_insert_rowid() AS r").get()!.r as number;
        handleId.set(h, hid);
      }
      db.query("INSERT INTO chat_handle_join(chat_id, handle_id) VALUES (?, ?)").run(cid, hid);
    }
  }
  return {
    query: <T = unknown>(sql: string) =>
      db.query(sql) as unknown as {
        all: (...p: unknown[]) => T[];
        get: (...p: unknown[]) => T | undefined;
      },
  } as unknown as ChatDb;
}

function configWithMode(mode: "*" | "dm_only" | "groupchat_only" | undefined): Config {
  return {
    outbound: { mode },
  } as unknown as Config;
}

describe("buildRelayEnvelope / parseInboundDepth", () => {
  test("round-trips depth through the envelope header", () => {
    const env = buildRelayEnvelope({
      originatorDisplayName: "Jordan Carter",
      message: "hey",
      additionalContext: null,
      depth: 2,
      targetIsGroup: false,
    });
    expect(env).toContain("[Relay from Jordan Carter · depth=2]");
    expect(parseInboundDepth(env)).toBe(2);
  });

  test("parseInboundDepth returns 0 for organic envelopes", () => {
    expect(parseInboundDepth("[iMessage · DM · whatever] hi")).toBe(0);
    expect(parseInboundDepth(undefined)).toBe(0);
    expect(parseInboundDepth("")).toBe(0);
  });

  test("includes additional_context only when non-empty", () => {
    const withCtx = buildRelayEnvelope({
      originatorDisplayName: "X",
      message: "m",
      additionalContext: "the saturday plans",
      depth: 1,
      targetIsGroup: false,
    });
    expect(withCtx).toContain("Additional context they shared: the saturday plans");

    const noCtx = buildRelayEnvelope({
      originatorDisplayName: "X",
      message: "m",
      additionalContext: "",
      depth: 1,
      targetIsGroup: true,
    });
    expect(noCtx).not.toContain("Additional context they shared:");
  });
});

describe("relativeAgo", () => {
  const NOW = 1_700_000_000_000;
  test("never for 0/null", () => {
    expect(relativeAgo(0, NOW)).toBe("never");
    expect(relativeAgo(-1, NOW)).toBe("never");
  });
  test("scales through minutes/hours/days", () => {
    expect(relativeAgo(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeAgo(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeAgo(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(relativeAgo(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });
});

describe("normalizeHandle (relevant phone variants)", () => {
  test("collapses formatting variants to the same canonical", () => {
    const a = normalizeHandle("+1 (555) 010-0001");
    const b = normalizeHandle("+1-555-010-0001");
    const c = normalizeHandle("+15550100001");
    expect(a).toBe(c);
    expect(b).toBe(c);
  });
  test("emails are lowercased", () => {
    expect(normalizeHandle("Foo@Example.COM")).toBe("foo@example.com");
  });
});

describe("relay() — input validation", () => {
  let dataDir: string;
  let state: StateStore;
  let crons: CronStore;
  let chatDb: ChatDb;
  const JORDAN = "+15550100001";
  const CASEY = "+15550100003";

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    state = new StateStore(dataDir);
    crons = new CronStore(dataDir);
    chatDb = buildFakeChatDb({
      handles: [JORDAN, CASEY],
      groups: [{ guid: "chat-fam", participants: [JORDAN, CASEY], displayName: "Family" }],
    });
  });

  afterEach(() => {
    state.close();
    crons.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function deps(config: Config) {
    return {
      config,
      chatDb,
      contacts: new ContactBook([]),
      state,
      crons,
    };
  }

  test("requires non-empty message", () => {
    const r = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "   ",
        additionalContext: null,
        isGroupChat: false,
        phoneNumber: CASEY,
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty/);
  });

  test("is_group_chat=true must come with group_chat_id, not phone_number", () => {
    const r1 = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: true,
        phoneNumber: CASEY,
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/forbids phone_number/);

    const r2 = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: true,
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/requires group_chat_id/);
  });

  test("is_group_chat=false must come with phone_number, not group_chat_id", () => {
    const r1 = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: false,
        groupChatId: "chat-fam",
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/forbids group_chat_id/);

    const r2 = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: false,
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/requires phone_number/);
  });

  test("DM target rejects email-shaped phone", () => {
    const r = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: false,
        phoneNumber: "casey@icloud.com",
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/phone number, not an email/);
  });

  test("DM target requires observability in chat.db", () => {
    const r = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: false,
        phoneNumber: "+19998887777",
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no message history/);
  });

  test("group target requires sender membership", () => {
    const r = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: "+15550000000",
        message: "hi",
        additionalContext: null,
        isGroupChat: true,
        groupChatId: "chat-fam",
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a participant/);
  });

  test("unknown group_chat_id is rejected", () => {
    const r = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: true,
        groupChatId: "chat-doesnotexist",
        inboundDepth: 0,
      },
      deps(configWithMode("*")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/);
  });

  test("outbound mode gating", () => {
    const dmInput = {
      originatorDisplayName: "Jordan",
      originatorHandle: JORDAN,
      message: "hi",
      additionalContext: null,
      isGroupChat: false,
      phoneNumber: CASEY,
      inboundDepth: 0,
    };
    const groupInput = {
      ...dmInput,
      isGroupChat: true,
      phoneNumber: undefined,
      groupChatId: "chat-fam",
    };

    expect(relay(dmInput, deps(configWithMode(undefined))).ok).toBe(false);
    expect(relay(groupInput, deps(configWithMode(undefined))).ok).toBe(false);

    expect(relay(dmInput, deps(configWithMode("dm_only"))).ok).toBe(true);
    expect(relay(groupInput, deps(configWithMode("dm_only"))).ok).toBe(false);

    expect(relay(dmInput, deps(configWithMode("groupchat_only"))).ok).toBe(false);
    expect(relay(groupInput, deps(configWithMode("groupchat_only"))).ok).toBe(true);

    expect(relay(dmInput, deps(configWithMode("*"))).ok).toBe(true);
    expect(relay(groupInput, deps(configWithMode("*"))).ok).toBe(true);
  });

  test("loop guard refuses past MAX_RELAY_DEPTH", () => {
    const r = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "hi",
        additionalContext: null,
        isGroupChat: false,
        phoneNumber: CASEY,
        inboundDepth: MAX_RELAY_DEPTH,
      },
      deps(configWithMode("*")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/loop guard/);
  });

  test("happy DM path enqueues a one-shot cron", () => {
    const d = deps(configWithMode("*"));
    const r = relay(
      {
        originatorDisplayName: "Jordan Carter",
        originatorHandle: JORDAN,
        message: "hey ask Casey about Saturday",
        additionalContext: "we're trying to lock in plans",
        isGroupChat: false,
        phoneNumber: CASEY,
        inboundDepth: 0,
      },
      d,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.targetSessionKey).toBe(`imessage:dm:${CASEY}`);
      expect(r.envelopeDepth).toBe(1);
    }
    const jobs = crons.listActive();
    expect(jobs.length).toBe(1);
    const job = jobs[0]!;
    expect(job.sessionKey).toBe(`imessage:dm:${CASEY}`);
    expect(job.systemEvent).toContain("[Relay from Jordan Carter · depth=1]");
    expect(job.systemEvent).toContain("hey ask Casey about Saturday");
    expect(job.systemEvent).toContain("Additional context");
    // Pre-warmed session record so the cron-fire path can bind to a session.
    expect(state.getSession(`imessage:dm:${CASEY}`)).not.toBeNull();
  });

  test("happy group path enqueues a one-shot cron for the group session", () => {
    const d = deps(configWithMode("*"));
    const r = relay(
      {
        originatorDisplayName: "Jordan",
        originatorHandle: JORDAN,
        message: "tell everyone about the change",
        additionalContext: null,
        isGroupChat: true,
        groupChatId: "chat-fam",
        inboundDepth: 0,
      },
      d,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.targetSessionKey).toBe("imessage:group:chat-fam");
    expect(crons.listActive().length).toBe(1);
  });
});
