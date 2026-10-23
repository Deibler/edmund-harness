/**
 * A proactive fire's outcome is read from every chat row the person reaches
 * Edmund through. IMCore gives one address two rows, plain and p:/e:-prefixed,
 * and the sweep read only the one the session recorded: a reply in the other
 * scored the fire "ignored", and engagement decay lengthened the cooldown for
 * someone who had answered.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepFireOutcomes } from "../src/ghost/outcomes.ts";
import { GhostPrefsStore } from "../src/ghost/prefs.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { SessionKey } from "../src/sessions/key.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const A = "+15550100031";
const B = "+15550100032";
const HOUR = 3_600_000;
const T = Date.now() - 3 * HOUR;
const nsAt = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec("ALTER TABLE chat ADD COLUMN style INTEGER");
  // Each person has the plain row the session recorded and a p: row.
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES
    (1, 'any;-;${A}', '${A}', 45), (2, 'any;-;p:${A}', 'p:${A}', 45),
    (3, 'any;-;${B}', '${B}', 45), (4, 'any;-;p:${B}', 'p:${B}', 45)`);
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES
    (1, '${A}', 'iMessage'), (2, 'p:${A}', 'iMessage'),
    (3, '${B}', 'iMessage'), (4, 'p:${B}', 'iMessage')`);
  w.exec(`INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1), (2, 2), (3, 3), (4, 4)`);
  const msg = (id: number, chat: number, handle: number, fromMe: number, ms: number, extra = "") =>
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, associated_message_type, associated_message_guid) VALUES (${id}, 'G${id}', 'x', ${handle}, ${fromMe}, ${nsAt(ms)}${extra || ", 0, NULL"});
       INSERT INTO chat_message_join (chat_id, message_id) VALUES (${chat}, ${id});`,
    );
  // A: Edmund's fire in the plain row, the reply an hour later in the p: row.
  msg(1, 1, 0, 1, T + 1_000);
  msg(2, 2, 2, 0, T + HOUR);
  // B: the fire, then only a heart on it, from the p: row.
  msg(3, 3, 0, 1, T + 1_000);
  msg(4, 4, 4, 0, T + HOUR, ", 2000, 'p:0/G3'");
  w.close();
}
const chatDb = new ChatDb(db.path);
const dir = mkdtempSync(join(tmpdir(), "ghost-outcome-chats-"));
const state = new StateStore(dir);
const prefs = new GhostPrefsStore(dir);
afterAll(() => {
  prefs.close();
  state.close();
  chatDb.close();
  db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const fireFor = (handle: string) => {
  const key = `imessage:dm:${handle}` as SessionKey;
  state.upsertSession({
    sessionKey: key,
    claudeSessionId: null,
    chatGuid: `any;-;${handle}`,
    isGroup: 0,
    lastInboundMs: 0,
    lastOutboundMs: 0,
  });
  prefs.markDelivered(prefs.recordFire({ sessionKey: key, firedAtMs: T, brief: "x", tags: [] }));
  return key;
};

describe("the outcome sweep", () => {
  test("a reply in the person's other chat row counts", () => {
    const a = fireFor(A);
    const b = fireFor(B);
    sweepFireOutcomes({ prefs, chatDb, state }, T + 2 * HOUR);
    expect(prefs.recentFires(a, 1)[0]?.outcome).toBe("engaged");
    const reacted = prefs.recentFires(b, 1)[0];
    expect(reacted?.outcome).toBe("reacted");
    expect(reacted?.reactionGlyph).toBeTruthy();
  });
});
