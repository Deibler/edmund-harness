/**
 * Which conversation a call belongs to.
 *
 * A call from a person is their DM; a Group FaceTime is the Messages group it
 * was started from. Both are derived from keyed sources only: the contact
 * book's canonical handle, and chat.db's `chat.group_id`, which is the same
 * UUID FaceTime reports as the conversation's Messages group. A display name
 * never decides it, and a group FaceTime that matches no Messages group has no
 * conversation and is not answered.
 */

import type { ChatDb } from "../imessage/db.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { type SessionKey, dmKeyFor } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import type { CallConversation, Peer } from "./types.ts";

type Deps = {
  chatDb: ChatDb;
  contacts: ContactBook;
};

/** The two things a session store must do for a call to reach its conversation. */
export type SessionRecords = {
  getSession: (sessionKey: SessionKey) => unknown;
  upsertSession: (record: {
    sessionKey: SessionKey;
    claudeSessionId: string | null;
    chatGuid: string;
    isGroup: number;
    lastInboundMs: number;
    lastOutboundMs: number;
  }) => void;
};

/**
 * Give the conversation a session record if it has none. Someone Edmund has
 * never exchanged a text with has no record, and a wake-up for a session
 * with no record is skipped: on 2026-11-06 and 11-11 the "it is ringing, write
 * your opening line" wake-up was dropped that way, so the person picked up to
 * 10 s of silence while a cold worker answered their "hello?" instead. The
 * record is the one their first text would have made.
 */
export function ensureSessionFor(conversation: CallConversation, state: SessionRecords): void {
  if (state.getSession(conversation.sessionKey)) return;
  state.upsertSession({
    sessionKey: conversation.sessionKey,
    claudeSessionId: null,
    chatGuid: conversation.chatGuid,
    isGroup: conversation.isGroup ? 1 : 0,
    lastInboundMs: 0,
    lastOutboundMs: 0,
  });
}

export function conversationForPeer(peer: Peer, deps: Deps): CallConversation | null {
  return peer.kind === "person"
    ? personConversation(peer.handle, deps)
    : groupConversation(peer, deps);
}

function personConversation(handle: string, { chatDb, contacts }: Deps): CallConversation {
  const canon = contacts.canon(handle);
  const sessionKey = dmKeyFor(canon);
  return {
    sessionKey,
    // Most recently active first, so this is the thread actually in use. A
    // person never texted has none yet; texts after the call go by handle,
    // which is how a first message starts a chat.
    chatGuid: chatGuidsForSession(sessionKey, chatDb, contacts)[0] ?? "",
    isGroup: false,
    label: contacts.label(canon) ?? canon,
    handles: [canon],
  };
}

function groupConversation(
  peer: Extract<Peer, { kind: "group" }>,
  { chatDb, contacts }: Deps,
): CallConversation | null {
  const row = chatDb
    .query<{ guid: string; name: string | null }>(
      `SELECT guid, display_name AS name FROM chat
       WHERE style = 43 AND upper(group_id) = upper(?)
       ORDER BY ROWID DESC LIMIT 1`,
    )
    .get(peer.messagesGroupId);
  if (!row) return null;
  return {
    sessionKey: `imessage:group:${row.guid}`,
    chatGuid: row.guid,
    isGroup: true,
    label: row.name?.trim() || "the group",
    handles: peer.handles.map((h) => contacts.canon(h)),
  };
}
