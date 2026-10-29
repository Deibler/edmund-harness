/**
 * A warm DM shows the model no history; the conversation itself holds it,
 * and after a compaction that is a summary plus the thread the
 * post-compaction hook put back. Recall used to skip a fixed 48 hours on the
 * premise the conversation still held them, while the operator's DM compacted
 * every 1.2 hours: on the median turn 140 of the previous two days' 144
 * messages were in neither (week of 2026-10-26). recallSightSince moves the
 * edge to where verbatim sight really begins.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallSightSince } from "../src/boot/wire-recall.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { VectorStore, normalize } from "../src/memory/vector-store.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const H = "+15550100041";
const GUID = `any;-;${H}`;
const KEY = `imessage:dm:${H}` as never;
const HOUR = 3_600_000;
const now = Date.now();
const nsAt = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

// The pull-station decision was made 5 hours ago; two more messages came
// before a compaction 2 hours ago, and one after it.
const msgs = [
  { guid: "M1", ms: now - 5 * HOUR, text: "pull station face: the led dot prints in clear pla" },
  { guid: "M2", ms: now - 3 * HOUR, text: "turkey feathers are next on the printer" },
  { guid: "M3", ms: now - 2.5 * HOUR, text: "red spool is low, keep plates single colour" },
  { guid: "M4", ms: now - 1 * HOUR, text: "pull station led dot clear pla reprint today" },
];
const COMPACTED_AT = now - 2 * HOUR;

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${GUID}', '${H}')`);
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (1, '${H}', 'iMessage')`);
  msgs.forEach((m, i) => {
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, associated_message_type) VALUES (${i + 1}, '${m.guid}', '${m.text}', 1, 0, ${nsAt(m.ms)}, 0)`,
    );
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ${i + 1})`);
  });
  w.close();
}
const chatDb = new ChatDb(db.path);
const dir = mkdtempSync(join(tmpdir(), "dm-sight-"));
const store = new VectorStore(join(dir, "r.sqlite"));
const provider = new HashEmbedProvider("h", 64);
afterAll(() => {
  store.close();
  chatDb.close();
  db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

// The hook re-injects the last two messages before the compaction (M2, M3).
const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: {},
  identity: {},
  behavior: { history_messages: 2 },
});
const contacts = { displayName: () => null, label: () => null } as unknown as ContactBook;
const deps = { config, chatDb, contacts, state: null };

async function seed() {
  const { vectors } = await provider.embed(msgs.map((m) => m.text));
  store.upsert(
    msgs.map((m, i) => ({
      ref: `msg:${m.guid}`,
      kind: "message" as const,
      chatGuid: GUID,
      sender: H,
      ts: m.ms,
      text: m.text,
      vec: normalize(vectors[i]!),
      model: "hash",
    })),
  );
}

async function recalled(excludeFromMs: number | undefined): Promise<string[]> {
  const r = await autoRecall("the pull station led dot, clear pla", provider, store, {
    chatGuid: GUID,
    limit: 10,
    minScore: 0.1,
    excludeRecentMs: 48 * HOUR,
    excludeFromMs,
  });
  return [...r.recent, ...r.deep].map((h) => h.ref);
}

describe("recallSightSince", () => {
  test("a warm DM's sight begins where the re-injected thread does", () => {
    // chat.db stores nanoseconds; the round trip can shift a millisecond.
    const since = recallSightSince(KEY, GUID, COMPACTED_AT, deps)!;
    expect(Math.abs(since - msgs[1]!.ms)).toBeLessThanOrEqual(1);
  });

  test("a boundary the turn already showed wins", () => {
    expect(recallSightSince(KEY, GUID, COMPACTED_AT, deps, 123)).toBe(123);
  });

  test("with nothing recorded the caller's fixed window applies", () => {
    expect(recallSightSince(KEY, GUID, 0, deps)).toBeUndefined();
  });

  test("recall reaches the decision the summary paraphrased, not what is in sight", async () => {
    await seed();
    const refs = await recalled(recallSightSince(KEY, GUID, COMPACTED_AT, deps));
    expect(refs).toContain("msg:M1");
    expect(refs).not.toContain("msg:M4");
    expect(refs).not.toContain("msg:M3");
    // The old fixed window: everything from the last two days was skipped.
    expect(await recalled(undefined)).not.toContain("msg:M1");
  });
});
