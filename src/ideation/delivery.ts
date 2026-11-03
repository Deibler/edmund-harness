import type { ChatDb } from "../imessage/db.ts";
import { decodeMessageText } from "../imessage/decode.ts";
import type { IdeationStore } from "./store.ts";

/**
 * Whether Edmund actually sent a page's link, read from chat.db and not from
 * "sent": a page counts as delivered once one of his own messages in that
 * person's chat, written after the page was announced to him, contains its
 * address. A page he chose not to send (KEEP_QUIET) simply never is.
 */

const APPLE_EPOCH_MS = 978_307_200_000;

export function sweepDeliveries(
  store: IdeationStore,
  chatDb: ChatDb,
  sessionKey: string,
  chatGuids: string[],
): number {
  const waiting = store.listUndelivered().filter((i) => i.sessionKey === sessionKey);
  if (waiting.length === 0 || chatGuids.length === 0) return 0;
  const since = Math.min(...waiting.map((i) => i.announcedMs ?? Number.MAX_SAFE_INTEGER));
  const rows = chatDb
    .query<{ text: string | null; ab: Uint8Array | null; date_ns: number }>(
      `SELECT m.text AS text, m.attributedBody AS ab, m.date AS date_ns
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
        WHERE c.guid IN (${chatGuids.map(() => "?").join(",")})
          AND m.is_from_me = 1 AND m.date >= ?
        ORDER BY m.date
        LIMIT 500`,
    )
    .all(...chatGuids, (since - APPLE_EPOCH_MS) * 1_000_000);
  let found = 0;
  for (const i of waiting) {
    const hit = rows.find((r) => {
      const at = Math.floor(r.date_ns / 1_000_000) + APPLE_EPOCH_MS;
      return at >= (i.announcedMs ?? 0) && decodeMessageText(r.text, r.ab).includes(`/i/${i.id}`);
    });
    if (hit) {
      store.markDelivered(i.id, Math.floor(hit.date_ns / 1_000_000) + APPLE_EPOCH_MS);
      found++;
    }
  }
  return found;
}
