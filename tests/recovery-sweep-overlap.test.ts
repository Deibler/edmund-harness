import { Database } from "bun:sqlite";
/**
 * The sweep runs on an interval that does not wait for the previous pass. A
 * recovery turn longer than the interval met a second sweep that saw the
 * same rows still owed, queued on the session lock, and answered them again
 * as soon as the first turn released it (2026-10-02: two near-identical
 * replies 26s apart; 33 such pairs in the daemon log since May).
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStore } from "../src/agents/store.ts";
import type { OperatorAlert } from "../src/alerts/operator-alert.ts";
import type { BgJobStore } from "../src/background/store.ts";
import { ConfigSchema } from "../src/config/config.ts";
import type { CronStore } from "../src/cron/store.ts";
import { ChatDb } from "../src/imessage/db.ts";
import { type SweeperDeps, sweepStuckSessions } from "../src/recovery/sweeper.ts";
import type { RecoveryResult } from "../src/recovery/turn.ts";
import { EchoCache } from "../src/sessions/echo-cache.ts";
import { SessionLocks } from "../src/sessions/locks.ts";
import { StateStore } from "../src/sessions/store.ts";
import { emptyChatDb } from "./helpers/chat-db.ts";

const HANDLE = "+15550100004";
const GUID = `any;-;${HANDLE}`;
const KEY = `imessage:dm:${HANDLE}`;
const NOW = Date.now();
const SENT_MS = NOW - 10 * 60_000;

const db = emptyChatDb();
{
  const w = new Database(db.path);
  w.exec("ALTER TABLE chat ADD COLUMN style INTEGER");
  w.exec(
    `INSERT INTO chat (ROWID, guid, chat_identifier, style) VALUES (1, '${GUID}', '${HANDLE}', 45)`,
  );
  w.exec(`INSERT INTO handle (ROWID, id, service) VALUES (1, '${HANDLE}', 'iMessage')`);
  const dateNs = (SENT_MS - 978_307_200_000) * 1_000_000;
  w.exec(
    `INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date) VALUES (1, 'G1', 'you there?', 1, 0, ${dateNs})`,
  );
  w.exec("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)");
  w.close();
}
const chatDb = new ChatDb(db.path);
const dataDir = mkdtempSync(join(tmpdir(), "sweep-overlap-"));
const state = new StateStore(dataDir);

afterAll(() => {
  state.close();
  chatDb.close();
  db.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a sweep that starts during another's recovery turn leaves that session alone", async () => {
  state.upsertSession({
    sessionKey: KEY,
    claudeSessionId: null,
    chatGuid: GUID,
    isGroup: 0,
    lastInboundMs: SENT_MS,
    lastOutboundMs: 0,
  });

  let calls = 0;
  let finishTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const runTurn = async (): Promise<RecoveryResult> => {
    calls++;
    await turnDone;
    return { ok: true, sent: 1, silenced: false, replayedRowIds: [1] };
  };

  const deps: SweeperDeps = {
    config: ConfigSchema.parse({ self: { handles: [] }, allowlist: {}, identity: {} }),
    state,
    agents: { list: () => [] } as unknown as AgentStore,
    bgJobs: { listForSession: () => [] } as unknown as BgJobStore,
    crons: { listActive: () => [], cancel: () => false } as unknown as CronStore,
    chatDb,
    echoes: new EchoCache(),
    locks: new SessionLocks(),
    alert: { notify: async () => {} } as unknown as OperatorAlert,
    activeSessions: new Set(),
    runTurn,
  };

  const first = sweepStuckSessions(deps, NOW);
  // Let the first sweep reach its (still running) recovery turn.
  for (let i = 0; i < 20 && calls === 0; i++) await Bun.sleep(5);
  expect(calls).toBe(1);

  // The next interval tick, while the first turn is still generating.
  const second = sweepStuckSessions(deps, NOW + 60_000);
  for (let i = 0; i < 20 && calls === 1; i++) await Bun.sleep(5);
  expect(calls).toBe(1);

  finishTurn();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});
