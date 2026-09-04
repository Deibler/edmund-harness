import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { InboundMessage } from "../imessage/types.ts";

/**
 * A parked inbound message — everything the coalesce gate needs to
 * reconstruct a faithful `InboundMessage` for the follow-up turn. Persisted
 * as one JSON line per message in `data/pending/<hash>.jsonl`.
 *
 * Fields beyond the original five (msgGuid, attachmentTranscripts,
 * replyToGuid, service, chatIdentifier, chatGuid, isGroup) were added later;
 * `parsePending` backfills sane defaults so a queue file written by an older
 * build still deserializes.
 */
export type PendingEntry = {
  rowId: number;
  /** stable message GUID — needed for echo cache + native reply-to threading */
  msgGuid: string;
  text: string | null;
  fromHandle: string;
  timestampMs: number;
  attachments: string[];
  /** Apple's on-device transcripts keyed by attachment path (voice notes) */
  attachmentTranscripts: Record<string, string>;
  /** parent message GUID if this is a threaded reply / quote */
  replyToGuid: string | null;
  service: string;
  chatIdentifier: string;
  chatGuid: string;
  isGroup: boolean;
};

function pendingPath(dataDir: string, sessionKey: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(sessionKey).digest("hex") as string;
  return join(dataDir, "pending", `${hash.slice(0, 16)}.jsonl`);
}

/**
 * Append a message to the session's pending queue file.
 * Called from the main watcher when a new message arrives for a session
 * that's currently locked (i.e. Claude is already running for it).
 */
export function writePending(sessionKey: string, msg: InboundMessage, dataDir: string): void {
  try {
    const path = pendingPath(dataDir, sessionKey);
    mkdirSync(join(dataDir, "pending"), { recursive: true });
    appendFileSync(path, `${JSON.stringify(toPendingEntry(msg))}\n`);
  } catch (err) {
    console.warn("[session-queue] writePending failed:", err);
  }
}

/** Serialize an inbound message to the parked-entry shape. Shared by the
 *  pending-queue file (coalescing) and the durable inbound_ack table
 *  (crash recovery) so both speak the same format. */
export function toPendingEntry(msg: InboundMessage): PendingEntry {
  return {
    rowId: msg.rowId,
    msgGuid: msg.msgGuid,
    text: msg.text,
    fromHandle: msg.fromHandle,
    timestampMs: msg.timestampMs,
    attachments: msg.attachments,
    attachmentTranscripts: msg.attachmentTranscripts,
    replyToGuid: msg.replyToGuid,
    service: msg.service,
    chatIdentifier: msg.chatIdentifier,
    chatGuid: msg.chatGuid,
    isGroup: msg.isGroup,
  };
}

/** Parse one serialized PendingEntry (an inbound_ack entry_json blob or a
 *  pending-file line). Null on garbage rather than throwing. */
export function parsePendingLine(json: string): PendingEntry | null {
  try {
    return normalizeEntry(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Reconstruct an `InboundMessage` from a self-contained entry (no fallback
 * ref available — the boot-replay path). Entries written by current builds
 * always carry the chat fields; null means a legacy/corrupt entry that
 * can't be faithfully rebuilt, and the caller should drop it with a log
 * rather than guess at chat routing.
 */
export function entryToInbound(e: PendingEntry): InboundMessage | null {
  if (!e.chatGuid || !e.chatIdentifier || !e.fromHandle) return null;
  return {
    rowId: e.rowId,
    msgGuid: e.msgGuid,
    chatIdentifier: e.chatIdentifier,
    chatGuid: e.chatGuid,
    isGroup: e.isGroup,
    fromHandle: e.fromHandle,
    fromMe: false,
    text: e.text ?? "",
    timestampMs: e.timestampMs,
    attachments: e.attachments,
    attachmentTranscripts: e.attachmentTranscripts,
    service: e.service || "iMessage",
    replyToGuid: e.replyToGuid,
  };
}

/** Coerce a parsed JSON line into a full PendingEntry, backfilling fields
 * that an older build wouldn't have written. */
function normalizeEntry(raw: Record<string, unknown>): PendingEntry | null {
  if (typeof raw.rowId !== "number") return null;
  return {
    rowId: raw.rowId,
    msgGuid: typeof raw.msgGuid === "string" ? raw.msgGuid : "",
    text: typeof raw.text === "string" ? raw.text : null,
    fromHandle: typeof raw.fromHandle === "string" ? raw.fromHandle : "",
    timestampMs: typeof raw.timestampMs === "number" ? raw.timestampMs : Date.now(),
    attachments: Array.isArray(raw.attachments) ? (raw.attachments as string[]) : [],
    attachmentTranscripts:
      raw.attachmentTranscripts && typeof raw.attachmentTranscripts === "object"
        ? (raw.attachmentTranscripts as Record<string, string>)
        : {},
    replyToGuid: typeof raw.replyToGuid === "string" ? raw.replyToGuid : null,
    service: typeof raw.service === "string" ? raw.service : "iMessage",
    chatIdentifier: typeof raw.chatIdentifier === "string" ? raw.chatIdentifier : "",
    chatGuid: typeof raw.chatGuid === "string" ? raw.chatGuid : "",
    isGroup: typeof raw.isGroup === "boolean" ? raw.isGroup : false,
  };
}

function parsePending(content: string): PendingEntry[] {
  const seen = new Set<number>();
  return content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const e = normalizeEntry(JSON.parse(line) as Record<string, unknown>);
        return e ? [e] : [];
      } catch {
        return [];
      }
    })
    .filter((e) => {
      if (seen.has(e.rowId)) return false;
      seen.add(e.rowId);
      return true;
    });
}

/**
 * Reconstruct an `InboundMessage` from a parked entry. `ref` is a message
 * from the same chat used only as a last-resort fallback for the chat-level
 * fields when an older queue file didn't persist them.
 */
export function pendingToInbound(e: PendingEntry, ref: InboundMessage): InboundMessage {
  return {
    rowId: e.rowId,
    msgGuid: e.msgGuid,
    chatIdentifier: e.chatIdentifier || ref.chatIdentifier,
    chatGuid: e.chatGuid || ref.chatGuid,
    isGroup: e.chatGuid ? e.isGroup : ref.isGroup,
    fromHandle: e.fromHandle,
    fromMe: false,
    text: e.text ?? "",
    timestampMs: e.timestampMs,
    attachments: e.attachments,
    attachmentTranscripts: e.attachmentTranscripts,
    service: e.service || ref.service,
    replyToGuid: e.replyToGuid,
  };
}

/**
 * Read and atomically clear the pending queue for a session.
 * Called by the coalesce gate at the end of a turn to fold parked
 * messages into the reply. Returns [] if nothing is queued.
 */
export function drainPending(sessionKey: string, dataDir: string): PendingEntry[] {
  const path = pendingPath(dataDir, sessionKey);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
    unlinkSync(path);
  } catch {
    return [];
  }
  return parsePending(content);
}

/**
 * Read the pending queue WITHOUT clearing it.
 * Used by the `check_incoming` MCP tool: the model can see follow-ups
 * mid-turn, but they stay queued so the post-turn coalesce gate still
 * folds them into the reply (or re-enqueues them) — no message gets lost
 * just because the model peeked at it.
 */
export function peekPending(sessionKey: string, dataDir: string): PendingEntry[] {
  const path = pendingPath(dataDir, sessionKey);
  if (!existsSync(path)) return [];
  try {
    return parsePending(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Delete the pending queue file for a session.
 * Called in handleBatch's finally block to clean up after a turn completes,
 * whether or not check_incoming drained it mid-turn.
 */
export function clearPending(sessionKey: string, dataDir: string): void {
  try {
    unlinkSync(pendingPath(dataDir, sessionKey));
  } catch {
    // File not present — nothing to do.
  }
}
