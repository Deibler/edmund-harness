/**
 * Best-effort session-key → pretty label. Uses the harness's ContactBook for
 * display names and falls back to the raw handle or chat name when the name
 * isn't known.
 */

import type { ChatDb } from "../../../src/imessage/db.ts";
import { getChatDisplayName, getGroupParticipants } from "../../../src/imessage/participants.ts";
import type { ContactBook } from "../../../src/sessions/contacts.ts";
import { chatIdFromKey, isGroupSession } from "../../../src/sessions/key.ts";

export type LabelDeps = { contacts: ContactBook; chatDb?: ChatDb };

export function sessionLabel(sessionKey: string, deps: LabelDeps): string {
  if (isGroupSession(sessionKey)) {
    const guid = chatIdFromKey(sessionKey);
    const chatName = deps.chatDb ? getChatDisplayName(deps.chatDb, guid) : null;
    if (chatName) return chatName;
    // Unnamed group → member names beat an opaque guid every time.
    if (deps.chatDb) {
      try {
        const members = getGroupParticipants(deps.chatDb, guid).map(
          (h) => deps.contacts.displayName(h) ?? h,
        );
        if (members.length > 0) {
          const shown = members.slice(0, 3).join(", ");
          return members.length > 3 ? `${shown} +${members.length - 3}` : shown;
        }
      } catch {
        // fall through to the guid label
      }
    }
    return `Group ${guid.slice(0, 12)}…`;
  }
  const handle = chatIdFromKey(sessionKey);
  return deps.contacts.displayName(handle) ?? handle;
}
