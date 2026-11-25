/**
 * Can a row left by a removed feature be taken for a live conversation?
 *
 * Two features that had their own session namespaces were removed: a trading
 * sub-persona (`trading:dm:<handle>`) and named orchestrators
 * (`orch:<name>:dm:<handle>`). A deployment that used either still has rows
 * keyed that way in state.db. The trading key carries a real person's
 * handle, and the code that once knew what it was is gone. Read as an
 * ordinary key it would name that person's own DM: the same chat, the same
 * sandbox folder, the same unanswered messages. A stale row that has not
 * replied since June then looks like a conversation owed a reply.
 *
 * So these rows are never listed, a retired key never yields the handle
 * inside it, and it never owns a message.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sandboxDir } from "../src/persona/sandbox.ts";
import { ownsRow } from "../src/recovery/sweeper.ts";
import { type SessionKey, chatIdFromKey, dmKeyFor, isRetiredSession } from "../src/sessions/key.ts";
import { StateStore } from "../src/sessions/store.ts";

const HANDLE = "+15550100002";
const LIVE = dmKeyFor(HANDLE);
const RETIRED = [
  `trading:dm:${HANDLE}`,
  `orch:desmond:dm:${HANDLE}`,
  "orch:desmond:group:any;+;chat1",
];

let dir: string;
let state: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "retired-sessions-"));
  state = new StateStore(dir);
  const hourAgo = Date.now() - 3_600_000;
  // Every row is owed a reply: the last inbound is newer than the last outbound.
  for (const sessionKey of [LIVE, ...RETIRED]) {
    state.upsertSession({
      sessionKey: sessionKey as SessionKey,
      claudeSessionId: "abc",
      chatGuid: `any;-;${HANDLE}`,
      isGroup: 0,
      lastInboundMs: hourAgo,
      lastOutboundMs: 0,
    });
  }
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a session left by a removed feature", () => {
  test("is recognised by its namespace, and a live one is not", () => {
    for (const key of RETIRED) expect([key, isRetiredSession(key)]).toEqual([key, true]);
    for (const key of [
      LIVE,
      "imessage:group:any;+;chat1",
      "sms:dm:+15550100003",
      "mirror:pi-4",
      "agent:a1",
    ]) {
      expect([key, isRetiredSession(key)]).toEqual([key, false]);
    }
  });

  test("is still in the database, so the guard is what keeps it out", () => {
    for (const key of RETIRED) expect(state.getSession(key as SessionKey)).not.toBeNull();
  });

  test("is not listed with the sessions", () => {
    expect(state.listSessions().map((s) => s.sessionKey)).toEqual([LIVE]);
  });

  test("is not a candidate for recovery, though it looks owed a reply", () => {
    expect(state.listSessionsNeedingRecovery(Date.now()).map((s) => s.sessionKey)).toEqual([LIVE]);
  });

  test("does not yield the handle inside its key", () => {
    expect(chatIdFromKey(LIVE)).toBe(HANDLE);
    for (const key of RETIRED) expect(chatIdFromKey(key as SessionKey)).toBe(key);
  });

  test("does not share a sandbox folder with that person's conversation", () => {
    const live = sandboxDir(LIVE);
    for (const key of RETIRED) expect(sandboxDir(key as SessionKey)).not.toBe(live);
  });

  test("owns no message that has no routing record", () => {
    expect(ownsRow(state, LIVE, 101)).toBe(true);
    for (const key of RETIRED)
      expect([key, ownsRow(state, key as SessionKey, 101)]).toEqual([key, false]);
  });
});
