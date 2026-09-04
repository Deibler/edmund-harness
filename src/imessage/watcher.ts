import { statSync, watch } from "node:fs";
import { log } from "../util/log.ts";
import { extractAppleTranscript } from "./apple-transcript.ts";
import { startBridgeEvents } from "./bridge-events.ts";
import type { ChatDb } from "./db.ts";
import { decodeMessageText } from "./decode.ts";
import type { InboundMessage } from "./types.ts";

// The chat and attachment joins are LEFT rather than INNER on purpose.
// Messages.app writes a message across several rows — message, then
// chat_message_join, then attachment — and at a 200ms poll the drain reads
// between those writes. An INNER JOIN made a half-written message invisible,
// the cursor advanced past it on the strength of a *later* row, and the
// message was never seen again: three photos in a group chat vanished this
// way. LEFT JOINs make the half-written row visible as "not ready yet", which
// the drain waits out instead of skipping.
const NEW_MESSAGES_SQL = `
  SELECT
    m.ROWID                   AS row_id,
    m.guid                    AS msg_guid,
    m.text                    AS text,
    m.attributedBody          AS attributed_body,
    m.date                    AS date_ns,
    m.is_from_me              AS from_me,
    m.cache_has_attachments   AS has_attachments,
    m.service                 AS service,
    m.associated_message_guid AS assoc_guid,
    m.associated_message_type AS assoc_type,
    c.chat_identifier         AS chat_identifier,
    c.guid                    AS chat_guid,
    c.style                   AS chat_style,
    h.id                      AS from_handle
  FROM message m
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c                ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h              ON h.ROWID = m.handle_id
  WHERE m.ROWID > ?
  ORDER BY m.ROWID ASC
  LIMIT 200
`;

const ATTACHMENTS_SQL = `
  SELECT a.filename AS filename, a.total_bytes AS total_bytes, a.user_info AS user_info
  FROM message_attachment_join maj
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE maj.message_id = ?
`;

type Row = {
  row_id: number;
  msg_guid: string;
  text: string | null;
  attributed_body: Uint8Array | null;
  date_ns: number;
  from_me: number;
  has_attachments: number;
  service: string | null;
  assoc_guid: string | null;
  assoc_type: number | null;
  chat_identifier: string | null;
  chat_guid: string | null;
  chat_style: number | null; // 43 = group, 45 = DM
  from_handle: string | null;
};

type AttachmentRow = {
  filename: string | null;
  total_bytes: number | null;
  user_info: Uint8Array | null;
};
type AttachmentStmt = { all: (rowId: number) => AttachmentRow[] };

/** How long a message may sit without its chat_message_join row. These land
 *  within the same write burst as the message, so a longer wait only delays
 *  everything behind a genuinely orphaned row. */
const JOIN_WAIT_MS = 10_000;
/** How long a message may sit with attachments still materialising. Downloads
 *  are network-bound — a full-size photo takes seconds, a long video can take
 *  a minute — and everything behind the row waits, so the ceiling is where
 *  "still downloading" becomes "wedged". */
const ATTACHMENT_WAIT_MS = 120_000;

/** The object-replacement character iMessage leaves where an attachment goes.
 *  Its presence says this message is supposed to carry files even when the
 *  attachment rows have not landed yet. */
const ATTACHMENT_PLACEHOLDER = "￼";

/**
 * Why this row cannot be delivered yet, or null when it can.
 *
 * "join": the chat_message_join row has not landed, so the message cannot be
 * routed to a conversation. "attachments": the message says it carries files
 * (cache_has_attachments, or a U+FFFC run in its text) but the attachment
 * rows are missing, unnamed, or the files on disk are still shorter than
 * their recorded size. transfer_state is deliberately not consulted — the
 * store holds thousands of long-delivered attachments still marked 0.
 */
function deliveryHoldup(r: Row, attachStmt: AttachmentStmt): "join" | "attachments" | null {
  if (r.chat_guid === null) return "join";
  // Our own sends attach files we already have on disk, and their upload
  // bookkeeping must not stall the inbound line behind them.
  if (r.from_me === 1) return null;

  // One placeholder per attachment, so their count says how many files this
  // message carries — which catches the drain landing between the first and
  // second attachment row of a multi-photo message and delivering half of it.
  const placeholders = (r.text ?? "").split(ATTACHMENT_PLACEHOLDER).length - 1;
  const expectsFiles = r.has_attachments === 1 || placeholders > 0;
  if (!expectsFiles) return null;

  const rows = attachStmt.all(r.row_id);
  if (rows.length < Math.max(placeholders, 1)) return "attachments";
  const home = process.env.HOME ?? "";
  for (const a of rows) {
    if (!a.filename) return "attachments";
    const path = a.filename.replace(/^~/, home);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return "attachments";
    }
    if (a.total_bytes && size < a.total_bytes) return "attachments";
  }
  return null;
}

/** Which push source wakes the drain loop. fs.watch is the universal default
 *  (works on stock macOS). `imsg` requires the `imsg` CLI but trades the 2s
 *  fs-safety-poll for sub-100ms latency. `auto` tries imsg first, falls back
 *  to fs on rapid restarts / spawn failure. */
type WatcherSource = "fs" | "imsg" | "auto";

export type WatcherOptions = {
  chatDb: ChatDb;
  chatDbPath: string;
  startCursor: number;
  /** Must be synchronous — the drain loop calls it per row without awaiting,
   *  so a quick path is critical when catching up after downtime (a hundreds-
   *  of-rows burst would otherwise pay a microtask trip per row). */
  onMessage: (m: InboundMessage) => void;
  onError?: (err: unknown) => void;
  /**
   * Called when `onMessage` has thrown `count` times in a row (a "poison
   * row" or a systemically broken handler — the cursor keeps advancing past
   * those rows, so messages are being dropped). Reset implicitly once any
   * `onMessage` call succeeds. Lets the daemon raise an operator alert.
   */
  onConsecutiveErrors?: (count: number, lastError: unknown) => void;
  /** How many consecutive `onMessage` throws trip `onConsecutiveErrors`. Default 5. */
  consecutiveErrorThreshold?: number;
  /** Push source. Default "auto". */
  source?: WatcherSource;
  /** Override {@link JOIN_WAIT_MS}. For tests. */
  joinWaitMs?: number;
  /** Override {@link ATTACHMENT_WAIT_MS}. For tests. */
  attachmentWaitMs?: number;
};

/**
 * Tail chat.db via fs.watch + ROWID cursor. fs.watch wakes us on file change;
 * we then drain all new rows. No timer polling.
 */
export function startWatcher(opts: WatcherOptions): () => void {
  const msgStmt = opts.chatDb.query<Row>(NEW_MESSAGES_SQL);
  const attachStmt = opts.chatDb.query<AttachmentRow>(ATTACHMENTS_SQL);
  let cursor = opts.startCursor;
  let draining = false;
  let pending = false;
  let closed = false;
  let consecutiveOnMessageErrors = 0;
  let alertedConsecutive = false;
  const errThreshold = Math.max(1, opts.consecutiveErrorThreshold ?? 5);

  const joinWaitMs = opts.joinWaitMs ?? JOIN_WAIT_MS;
  const attachmentWaitMs = opts.attachmentWaitMs ?? ATTACHMENT_WAIT_MS;
  // When the row at the head of the line was first found not ready. Only the
  // head can wait — everything behind it is blocked on it — so this holds at
  // most a handful of entries and empties as soon as the line moves.
  const heldSince = new Map<number, number>();

  const drain = (): void => {
    if (draining) {
      pending = true;
      return;
    }
    draining = true;
    try {
      outer: while (!closed) {
        const rows = msgStmt.all(cursor);
        if (rows.length === 0) break;
        for (const r of rows) {
          // A message that is not fully written yet — its chat join or its
          // attachment files still landing — stops the line rather than being
          // skipped: the cursor is a high-water mark, so a row passed over
          // here would never be seen again. The 200ms poll retries; the
          // deadline keeps one broken row from wedging inbound forever.
          const holdup = deliveryHoldup(r, attachStmt);
          if (holdup) {
            const since = heldSince.get(r.row_id) ?? Date.now();
            heldSince.set(r.row_id, since);
            const limit = holdup === "join" ? joinWaitMs : attachmentWaitMs;
            if (Date.now() - since < limit) break outer;
            heldSince.delete(r.row_id);
            if (holdup === "join") {
              // Still no conversation to route it to — undeliverable.
              log.warn("watcher", "skipping message that never joined a chat", {
                row: r.row_id,
                waited_ms: Date.now() - since,
              });
              cursor = r.row_id;
              continue;
            }
            log.warn("watcher", "delivering with attachments still incomplete after deadline", {
              row: r.row_id,
              waited_ms: Date.now() - since,
            });
          } else {
            const since = heldSince.get(r.row_id);
            if (since !== undefined) {
              heldSince.delete(r.row_id);
              log.info("watcher", "message finished being written, delivering", {
                row: r.row_id,
                waited_ms: Date.now() - since,
              });
            }
          }
          cursor = r.row_id;
          const msg = rowToMessage(r, attachStmt);
          if (!msg) continue;
          try {
            opts.onMessage(msg);
            if (consecutiveOnMessageErrors > 0) consecutiveOnMessageErrors = 0;
            alertedConsecutive = false;
          } catch (err) {
            opts.onError?.(err);
            consecutiveOnMessageErrors++;
            if (consecutiveOnMessageErrors >= errThreshold && !alertedConsecutive) {
              alertedConsecutive = true;
              opts.onConsecutiveErrors?.(consecutiveOnMessageErrors, err);
            }
          }
        }
      }
    } finally {
      draining = false;
      if (pending && !closed) {
        pending = false;
        drain();
      }
    }
  };

  drain();

  // Inbound has one source of truth: chat.db. The poll below always runs, and
  // bridge events (when this process holds the bridge) only wake it sooner.
  // Nothing here chooses between sources, so there is no stall watchdog, no
  // restart ladder and no give-up path — all of which existed because the push
  // stream used to be the only trigger and could go silent while looking alive.
  const desired: WatcherSource = opts.source ?? "auto";

  const attachChatDb = (): { teardown: () => void } => {
    const onWatchEvent = () => drain();
    // fs.watch silently emits 'error' and stops firing change events on macOS
    // if the watched file is renamed or replaced, which sqlite WAL checkpoints
    // do. Attach handlers so the glitch is at least visible in the log; the
    // ROWID poll below is what keeps inbound working through it.
    const mainWatcher = watch(opts.chatDbPath, { persistent: true }, onWatchEvent);
    mainWatcher.on("error", (err) => {
      log.warn("watcher", "fs.watch(chat.db) error — relying on the ROWID backstop poll", {
        err: err.message,
      });
    });
    let walWatcher: ReturnType<typeof watch> | null = null;
    try {
      walWatcher = watch(`${opts.chatDbPath}-wal`, { persistent: true }, onWatchEvent);
      walWatcher.on("error", (err) => {
        log.warn("watcher", "fs.watch(chat.db-wal) error", { err: err.message });
      });
    } catch {
      // WAL file may not exist yet; watching chat.db alone is sufficient.
    }
    // Don't hold the event loop open on daemon shutdown; teardown closes
    // watchers explicitly, but unref() ensures a stuck-shutdown still exits.
    mainWatcher.unref?.();
    walWatcher?.unref?.();

    // The backstop that actually decides inbound latency.
    //
    // It polled `PRAGMA data_version`, and only when fs.watch had been quiet for
    // ten seconds. Both halves were wrong. chat.db is WAL and Messages writes to
    // the -wal constantly — receipts, typing state, checkpoints — so fs.watch was
    // almost never quiet and the backstop almost never ran. Detection then rested
    // entirely on an fs.watch event landing after a row became visible, and when
    // that did not happen messages sat unnoticed for over a minute.
    //
    // `MAX(ROWID)` against the cursor is an index lookup, cheap enough to run
    // every 200ms unconditionally. It is also an absolute check rather than a
    // change-detection one, so it cannot miss an edge: correctness no longer
    // depends on any event mechanism firing, and the push paths are left as pure
    // latency accelerators.
    const POLL_MS = 200;
    const maxRowStmt = opts.chatDb.query<{ max_row: number | null }>(
      "SELECT MAX(ROWID) AS max_row FROM message",
    );
    // Soft backoff on consecutive query failures so a transient db
    // lock or briefly-missing file doesn't turn the 200ms poll into a
    // 5-per-second flood of error logs.
    let consecutiveFailures = 0;
    let skipUntil = 0;
    const pollTimer = setInterval(() => {
      if (closed) return;
      if (Date.now() < skipUntil) return;
      try {
        const maxRow = maxRowStmt.get()?.max_row ?? 0;
        consecutiveFailures = 0;
        if (maxRow > cursor) drain();
      } catch (err) {
        consecutiveFailures++;
        // Exponential backoff capped at 30s, only log every 10th miss
        // so a sustained outage doesn't spam the log.
        const backoffMs = Math.min(30_000, 200 * 2 ** consecutiveFailures);
        skipUntil = Date.now() + backoffMs;
        if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
          log.warn("watcher", "inbound backstop poll failed", {
            err: (err as Error).message,
            consecutive: consecutiveFailures,
            backoff_ms: backoffMs,
          });
        }
      }
    }, POLL_MS);
    pollTimer.unref?.();

    return {
      teardown: () => {
        clearInterval(pollTimer);
        mainWatcher.close();
        walWatcher?.close();
      },
    };
  };

  const { teardown: pollTeardown } = attachChatDb();
  // "fs" keeps the accelerator off, for an operator who wants the poll alone.
  const events = desired === "fs" ? null : startBridgeEvents({ onWake: () => drain() });
  const teardown = () => {
    events?.stop();
    pollTeardown();
  };
  const attached = events ? "chat.db + bridge events" : "chat.db";
  log.info("watcher", `inbound: ${attached} (requested: ${desired})`);

  return () => {
    closed = true;
    teardown();
  };
}

/**
 * One-shot read of every message with ROWID > startCursor, parsed to InboundMessage.
 * Used by the boot catch-up phase to fetch the whole downtime backlog at once so it can be
 * coalesced per-chat into a single turn — instead of replaying it message-by-message through
 * the live pipeline (which fired one reply per missed message = the recovery spam).
 * Returns the parsed messages and the new high-watermark rowId.
 */
export function readBacklog(opts: { chatDb: ChatDb; startCursor: number }): {
  messages: InboundMessage[];
  maxRowId: number;
} {
  const msgStmt = opts.chatDb.query<Row>(NEW_MESSAGES_SQL);
  const attachStmt = opts.chatDb.query<AttachmentRow>(ATTACHMENTS_SQL);
  const messages: InboundMessage[] = [];
  let cursor = opts.startCursor;
  while (true) {
    const rows = msgStmt.all(cursor);
    if (rows.length === 0) break;
    for (const r of rows) {
      cursor = r.row_id;
      const msg = rowToMessage(r, attachStmt);
      if (msg) messages.push(msg);
    }
  }
  return { messages, maxRowId: cursor };
}

function rowToMessage(r: Row, attachStmt: AttachmentStmt): InboundMessage | null {
  // No chat row means no conversation to attribute the message to. The live
  // drain waits joins out and only lets a row through here after the deadline,
  // so this is the undeliverable-orphan case, not the mid-write one.
  if (r.chat_guid === null || r.chat_identifier === null) return null;
  // The object-replacement character is where an attachment sits in the text,
  // not something anyone typed. Left in, a caption-less image whose files
  // never materialised would pass the emptiness check below on the strength
  // of a placeholder alone and be delivered as a message saying nothing.
  const text = decodeMessageText(r.text, r.attributed_body)
    .replaceAll(ATTACHMENT_PLACEHOLDER, "")
    .trim();
  const timestampMs = Math.floor(r.date_ns / 1_000_000) + 978_307_200_000;
  const home = process.env.HOME ?? "";
  const attachments: string[] = [];
  const attachmentTranscripts: Record<string, string> = {};
  for (const a of attachStmt.all(r.row_id)) {
    const path = (a.filename ?? "").replace(/^~/, home);
    if (!path) continue;
    attachments.push(path);
    const apple = extractAppleTranscript(a.user_info);
    if (apple) attachmentTranscripts[path] = apple;
  }
  if (!text && attachments.length === 0) return null;
  return {
    rowId: r.row_id,
    msgGuid: r.msg_guid,
    chatIdentifier: r.chat_identifier,
    chatGuid: r.chat_guid,
    isGroup: r.chat_style === 43,
    fromHandle: r.from_handle ?? "",
    fromMe: r.from_me === 1,
    text,
    timestampMs,
    attachments,
    attachmentTranscripts,
    service: r.service ?? "iMessage",
    replyToGuid: parseReplyGuid(r.assoc_guid, r.assoc_type),
  };
}

/**
 * iMessage stores reply relationships in `associated_message_guid` prefixed
 * with a protocol tag: `p:0/<guid>` = threaded reply, `bp:<guid>` = quoted
 * reply. Tapback reactions also use this field (`associated_message_type`
 * 2000-3005) but we only want true replies — type 0 on the reply message
 * with the prefix indicates a plain textual reply to another message.
 */
function parseReplyGuid(assoc: string | null, type: number | null): string | null {
  if (!assoc) return null;
  // Tapbacks occupy 2000-3005 (like, love, laugh, etc). We only care about replies.
  if (type !== null && type >= 2000 && type <= 3099) return null;
  const m = assoc.match(/^(?:p:\d+\/|bp:)?([0-9A-F-]{36})$/i);
  return m ? m[1]! : null;
}
