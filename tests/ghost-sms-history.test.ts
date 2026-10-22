import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import { GhostPrefsStore, autoEnrollSessions } from "../src/ghost/prefs.ts";
import { type GhostSmsHistory, buildPromptInput } from "../src/ghost/think.ts";
import type { ChatDb } from "../src/imessage/db.ts";
import type { HistoryLine } from "../src/imessage/history.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import type { SessionKey } from "../src/sessions/key.ts";

/**
 * The ghost (proactive outreach) read every conversation from chat.db,
 * which has no rows for a Twilio conversation. It judged an SMS group
 * holding 25+ messages "a fresh session with zero message history" and
 * decided on that basis. These build its real prompt for an SMS session
 * with a chat.db that throws when touched: drop the SMS branch and they go
 * red.
 */

const SID = "CH00000000000000000000000000000004";
const KEY = `sms:group:${SID}` as SessionKey;
const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
const contacts = {
  displayName: () => null,
  label: (h: string) => (h === "+15550100021" ? "Alex" : null),
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

function line(minutesAgo: number, text: string, fromMe = false): HistoryLine {
  return {
    rowId: minutesAgo,
    timestampMs: Date.now() - minutesAgo * 60_000,
    fromHandle: fromMe ? "" : "+15550100021",
    fromMe,
    text,
    isTapback: false,
    tapbackTargetIsMe: false,
    tapbackTargetHandle: "",
  };
}

const sms: GhostSmsHistory = {
  history: (conversationId) =>
    conversationId === SID
      ? [
          line(30, "who's going to the beer garden thursday"),
          line(29, "Locked in for Thursday.", true),
          line(5, "can we do another time this weekend?"),
        ]
      : [],
};

let dir: string;
let prefs: GhostPrefsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ghost-sms-"));
  prefs = new GhostPrefsStore(dir);
  autoEnrollSessions(prefs, [{ sessionKey: KEY, isGroup: true }], {
    dmEnabled: true,
    groupEnabled: true,
    timezone: "America/New_York",
    weeklyCap: 3,
  });
});

afterEach(() => {
  prefs.close();
  rmSync(dir, { recursive: true, force: true });
});

function prompt(): string {
  const sessionPrefs = prefs.get(KEY);
  if (!sessionPrefs) throw new Error("not enrolled");
  return buildPromptInput({
    sessionKey: KEY,
    sessionPrefs,
    nowMs: Date.now(),
    config,
    chatDb,
    contacts,
    sms,
    recentFires: [],
  });
}

describe("the ghost reads an SMS conversation from the SMS store", () => {
  test("the prompt carries the SMS transcript, not an empty session", () => {
    const p = prompt();
    expect(p).toContain("CONVERSATION_ARC: 3 msgs");
    expect(p).not.toContain("fresh session");
    expect(p).toContain("can we do another time this weekend?");
  });
});
