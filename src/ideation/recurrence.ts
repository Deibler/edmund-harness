import type { ChatDb } from "../imessage/db.ts";
import { easternDate } from "../util/clock.ts";

/**
 * Whether an interest really recurs, decided from chat.db and not from what a
 * model says about it.
 *
 * The ideator groups a person's questions into threads and cites the messages
 * behind each one. Grouping is the model's job: on real transcripts, clustering
 * the stored embeddings at a fixed similarity either fused a month of unrelated
 * questions into one blob or split "the sky" into sunsets in one cluster and
 * light years in another (measured 2026-11-03). Counting is not the model's
 * job. A cited message only counts when chat.db has it, it is in this person's
 * chat, they wrote it (not Edmund, not a reaction), and it falls inside the
 * window. A thread recurs when what is left spans enough separate days.
 */

export type RecurrenceRule = {
  nowMs: number;
  /** Only messages from the last this-many days count. */
  windowDays: number;
  /** Distinct home-timezone days the valid evidence must span. */
  minDays: number;
};

export type Rejection = {
  rowId: number;
  why: "not found" | "other chat" | "from Edmund" | "reaction" | "outside window";
};

export type RecurrenceCheck = {
  ok: boolean;
  /** Distinct days of the accepted evidence, oldest first. */
  days: string[];
  accepted: number[];
  rejected: Rejection[];
};

const APPLE_EPOCH_MS = 978_307_200_000;

export function verifyRecurrence(
  chatDb: ChatDb,
  chatGuids: string[],
  rowIds: number[],
  rule: RecurrenceRule,
): RecurrenceCheck {
  const ids = [...new Set(rowIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  const fail: RecurrenceCheck = { ok: false, days: [], accepted: [], rejected: [] };
  if (ids.length === 0 || chatGuids.length === 0) return fail;

  const rows = chatDb
    .query<{
      row_id: number;
      from_me: number;
      date_ns: number;
      assoc_type: number | null;
      chat_guid: string | null;
    }>(
      `SELECT m.ROWID AS row_id, m.is_from_me AS from_me, m.date AS date_ns,
              m.associated_message_type AS assoc_type, c.guid AS chat_guid
         FROM message m
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE m.ROWID IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);

  // A message can sit in more than one chat row; it belongs to this person
  // when any of them is one of theirs.
  const byId = new Map<number, (typeof rows)[number] & { ours: boolean }>();
  const ours = new Set(chatGuids);
  for (const r of rows) {
    const prev = byId.get(r.row_id);
    const mine = r.chat_guid !== null && ours.has(r.chat_guid);
    byId.set(r.row_id, { ...r, ours: (prev?.ours ?? false) || mine });
  }

  const sinceMs = rule.nowMs - rule.windowDays * 86_400_000;
  const accepted: number[] = [];
  const rejected: Rejection[] = [];
  const days = new Set<string>();
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) {
      rejected.push({ rowId: id, why: "not found" });
      continue;
    }
    if (!r.ours) {
      rejected.push({ rowId: id, why: "other chat" });
      continue;
    }
    if (r.from_me === 1) {
      rejected.push({ rowId: id, why: "from Edmund" });
      continue;
    }
    if ((r.assoc_type ?? 0) !== 0) {
      rejected.push({ rowId: id, why: "reaction" });
      continue;
    }
    const ms = Math.floor(r.date_ns / 1_000_000) + APPLE_EPOCH_MS;
    if (ms < sinceMs || ms > rule.nowMs) {
      rejected.push({ rowId: id, why: "outside window" });
      continue;
    }
    accepted.push(id);
    days.add(easternDate(new Date(ms)));
  }
  const sorted = [...days].sort();
  return { ok: sorted.length >= rule.minDays, days: sorted, accepted, rejected };
}
