/**
 * A parked message that was also shown to the running turn, and seen there,
 * belongs to that turn: no follow-up pass and no turn of its own, or the model
 * answers it twice. A failed turn answered nothing, so its parked messages are
 * re-queued whatever was shown.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PendingEntry,
  drainPending,
  parsePendingLine,
  splitSeenMidTurn,
  writePending,
} from "../src/bridge/session-queue.ts";
import type { InboundMessage } from "../src/imessage/types.ts";

const dir = mkdtempSync(join(tmpdir(), "mid-turn-queue-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const KEY = "imessage:group:any;+;chat5550100";
const src = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

const msg = (rowId: number): InboundMessage => ({
  rowId,
  msgGuid: `G${rowId}`,
  chatIdentifier: "chat5550100",
  chatGuid: "any;+;chat5550100",
  isGroup: true,
  fromHandle: "+15550100021",
  fromMe: false,
  text: `message ${rowId}`,
  timestampMs: 1_761_400_000_000 + rowId,
  attachments: [],
  attachmentTranscripts: {},
  service: "iMessage",
  replyToGuid: null,
});

describe("the parked queue", () => {
  test("keeps the uuid a message was shown under", () => {
    writePending(KEY, msg(1), dir, "u-1");
    writePending(KEY, msg(2), dir);
    const [shown, plain] = drainPending(KEY, dir);
    // The loader rebuilds entries from a fixed field list; a field it does not
    // name is dropped, and every shown message would be answered twice.
    expect(shown?.midTurnUuid).toBe("u-1");
    expect(plain?.midTurnUuid).toBeUndefined();
    expect(parsePendingLine(JSON.stringify(shown))?.midTurnUuid).toBe("u-1");
  });

  test("splits what the turn saw from what it did not", () => {
    const e = (rowId: number, midTurnUuid?: string) =>
      ({ rowId, ...(midTurnUuid ? { midTurnUuid } : {}) }) as PendingEntry;
    const { seen, rest } = splitSeenMidTurn([e(1, "u-1"), e(2, "u-2"), e(3)], new Set(["u-1"]));
    expect(seen.map((x) => x.rowId)).toEqual([1]);
    // Shown but never seen (it missed the turn), and never shown: both stay.
    expect(rest.map((x) => x.rowId)).toEqual([2, 3]);
  });
});

describe("the turn's wiring", () => {
  const turn = src("src/channels/turn.ts");

  test("every success path drains through the seen filter; the failure path does not", () => {
    // Two raw drains: inside drainUnanswered, and handleBatch's finally, which
    // re-queues whatever a failed or aborted turn left parked.
    expect(turn.match(/drainPending\(/g)).toHaveLength(2);
    expect(turn).toMatch(
      /splitSeenMidTurn\(drainPending\(key, config\.paths\.data_dir\), seenMidTurn\)/,
    );
    expect(turn).toMatch(/const leftovers = drainPending\(key, deps\.config\.paths\.data_dir\);/);
    // The tool-only, KEEP_DRAFT, follow-up pass and iteration-cap drains.
    expect(turn.match(/drainUnanswered\(\)/g)).toHaveLength(4);
  });

  test("a turn counts what it saw only when it succeeded", () => {
    const after = turn.slice(turn.indexOf("const result = await runModel("));
    expect(after).toMatch(
      /const seenNow = takeSeenMidTurn\(key\);\s*if \(result\.ok\) for \(const u of seenNow\) seenMidTurn\.add\(u\);/,
    );
  });

  test("the daemon shows a message to the running turn and parks it with its uuid", () => {
    const main = src("src/main.ts");
    const active = main.slice(main.indexOf("if (activeSessions.has(key)) {"));
    expect(active).toMatch(/const shown = bargeIn\s*\? null\s*: showToRunningTurn\(key, msg,/);
    expect(active).toMatch(
      /writePending\(key, msg, config\.paths\.data_dir, shown \?\? undefined\);/,
    );
    expect(active.indexOf("showToRunningTurn(")).toBeLessThan(active.indexOf("writePending("));
  });
});
