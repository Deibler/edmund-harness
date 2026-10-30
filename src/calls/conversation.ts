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
import { dmKeyFor } from "../sessions/key.ts";
import { chatGuidsForSession } from "../sessions/session-scope.ts";
import type { CallConversation, Peer } from "./types.ts";

type Deps = {
  chatDb: ChatDb;
  contacts: ContactBook;
};

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
