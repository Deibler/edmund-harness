/**
 * Whether Edmund has spoken in a group's active thread is read from the
 * thread's own rows. The harness stamps its last send when the send returns,
 * after chat.db has dated the message, so a reply that closed the thread fell
 * outside the window [start, end] and the scope line told the model "You
 * haven't replied in this thread yet" right above its own reply (39% of group
 * turns, 2026-10-23).
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHistoryBundle } from "../src/channels/history.ts";
import { ConfigSchema } from "../src/config/config.ts";
import { ChatDb } from "../src/imessage/db.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { autoRecall } from "../src/memory/auto-recall.ts";
import { HashEmbedProvider } from "../src/memory/embed-provider.ts";
import { VectorStore, normalize } from "../src/memory/vector-store.ts";
import type { ContactBook } from "../src/sessions/contacts.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const GUID = "any;+;chat5550100";
const A = "+15550100021";
const B = "+15550100022";
const now = Date.now();
const nsAt = (ms: number) => (ms - 978_307_200_000) * 1_000_000;

// Two members talk, Edmund replies last, then a member writes again.
const rows: [string, number, string, number][] = [
  [A, 0, "anyone up for pickleball saturday", now - 240_000],
  [B, 0, "I'm in if it's after noon", now - 200_000],
  ["", 1, "Saturday after noon works, I'll put it on the list", now - 160_000],
  [A, 0, "perfect, what courts?", now - 30_000],
];
const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec(`INSERT INTO chat (ROWID, guid, chat_identifier) VALUES (1, '${GUID}', 'chat5550100')`);
  w.exec(
    `INSERT INTO handle (ROWID, id, service) VALUES (1, '${A}', 'iMessage'), (2, '${B}', 'iMessage')`,
  );
  rows.forEach(([from, fromMe, text, ms], i) => {
    const handleId = from === A ? 1 : from === B ? 2 : 0;
    w.exec(
      `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, associated_message_type) VALUES (${i + 1}, 'G${i + 1}', '${text.replace(/'/g, "''")}', ${handleId}, ${fromMe}, ${nsAt(ms)}, 0)`,
    );
    w.exec(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ${i + 1})`);
  });
  w.close();
}
const chatDb = new ChatDb(db.path);
const dir = mkdtempSync(join(tmpdir(), "group-scope-"));
const state = new StateStore(dir);
afterAll(() => {
  state.close();
  chatDb.close();
  db.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const config = ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} });
const contacts = { displayName: () => null, label: () => null } as unknown as ContactBook;
const inbound: InboundMessage = {
  rowId: 4,
  msgGuid: "G4",
  chatIdentifier: "chat5550100",
  chatGuid: GUID,
  isGroup: true,
  fromHandle: A,
  fromMe: false,
  text: "perfect, what courts?",
  timestampMs: now - 30_000,
  attachments: [],
  attachmentTranscripts: {},
  service: "iMessage",
  replyToGuid: null,
} as InboundMessage;

const bundleFor = (lastOutboundMs: number) =>
  buildHistoryBundle(
    inbound,
    [inbound],
    false,
    true,
    lastOutboundMs,
    { config, chatDb, contacts, state } as never,
    `imessage:group:${GUID}` as never,
  );
const scopeFor = (lastOutboundMs: number) => bundleFor(lastOutboundMs).scope ?? "";

describe("the group scope line", () => {
  test("Edmund's reply that closed the thread counts, whatever the send stamp", () => {
    // The send returned ~100 ms after chat.db dated the reply.
    const scope = scopeFor(now - 160_000 + 100);
    expect(scope).not.toContain("haven't replied");
    expect(scope).toMatch(/You last replied in this thread (2|3)m ago\./);
  });

  test("a stale or missing stamp does not hide the reply either", () => {
    expect(scopeFor(0)).toContain("You last replied in this thread");
  });
});

describe("recall around a group's shown thread", () => {
  test("a trimmed thread reports its first kept line, so the rest stays findable", () => {
    const trimmedConfig = ConfigSchema.parse({
      self: { handles: [] },
      allowlist: {},
      identity: {},
      behavior: { history_max_per_segment: 2 },
    });
    const b = buildHistoryBundle(
      inbound,
      [inbound],
      false,
      true,
      0,
      { config: trimmedConfig, chatDb, contacts, state } as never,
      `imessage:group:${GUID}` as never,
    );
    // Rows 2 and 3 are kept; row 1 (at -240 s) was trimmed.
    expect(Math.abs((b.shownSinceMs ?? 0) - (now - 200_000))).toBeLessThanOrEqual(1);
  });

  test("history reports where the thread it shows begins", () => {
    // The active thread is everything in the fixture: it starts at the first row.
    // chat.db stores nanoseconds past 2^53, so the round trip may be 1 ms off.
    expect(Math.abs((bundleFor(0).shownSinceMs ?? 0) - (now - 240_000))).toBeLessThanOrEqual(1);
  });

  test("recall skips exactly what the envelope shows, however long the embed takes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-boundary-"));
    const store = new VectorStore(join(dir, "v.sqlite"));
    const hash = new HashEmbedProvider();
    // A slow embed: a duration measured before it would land late.
    const provider = {
      ...hash,
      model: hash.model,
      dim: hash.dim,
      embed: async (texts: string[]) => {
        await Bun.sleep(80);
        return hash.embed(texts);
      },
    } as unknown as HashEmbedProvider;
    try {
      const text = "pickleball courts saturday after noon";
      const vec = normalize((await hash.embed([text])).vectors[0]!);
      const boundary = Date.now() - 60_000;
      const row = (ref: string, ts: number) => ({
        ref,
        kind: "message" as const,
        chatGuid: GUID,
        sender: A,
        ts,
        text,
        vec,
        model: hash.model,
      });
      store.upsert([row("msg:shown", boundary), row("msg:earlier", boundary - 3_600_000)]);
      const res = await autoRecall(text, provider, store, {
        chatGuid: GUID,
        limit: 10,
        minScore: -1,
        excludeRecentMs: 48 * 3_600_000,
        excludeFromMs: boundary,
      });
      const refs = [...res.recent, ...res.deep].map((h) => h.ref);
      expect(refs).toContain("msg:earlier"); // same day, before the shown thread
      expect(refs).not.toContain("msg:shown"); // already in the envelope
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the turn hands recall the history's boundary", () => {
    const turn = readFileSync(join(import.meta.dir, "../src/channels/turn.ts"), "utf8");
    expect(turn.indexOf("const historyBundle =")).toBeLessThan(
      turn.indexOf("const autoRecallPromise"),
    );
    expect(turn).toMatch(/autoRecallFn\([^)]*historyBundle\.shownSinceMs,?\s*\)/);
    const wire = readFileSync(join(import.meta.dir, "../src/boot/wire-recall.ts"), "utf8");
    expect(wire).toContain("excludeFromMs: shownSinceMs,");
  });
});
