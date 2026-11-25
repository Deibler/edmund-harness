import type { InboundMessage } from "../imessage/types.ts";

/**
 * Session key is the unit of Claude conversational memory.
 *
 * Group chats: one session per group GUID — everyone in the room shares
 * context, and the assistant sees the full thread as one ongoing conversation.
 *
 * DMs: one session per contact (canonical handle) — each person has their
 * own private thread with the assistant. Canonicalization lets the same person
 * reach the assistant via phone or email without splitting session memory.
 */
export type SessionKey = string;

const PREFIX_DM = "imessage:dm:";
const PREFIX_GROUP = "imessage:group:";
/**
 * Namespaces of features that were removed: a trading sub-persona
 * (`trading:dm:<handle>`) and named orchestrators (`orch:<name>:…`). Nothing
 * creates such a key any more, but a deployment that used either still has
 * rows keyed this way in state.db and in the routing table. They must never
 * be acted on. A trading key in particular carries a real person's handle:
 * treated as an ordinary key it would resolve to that person's live DM, its
 * sandbox and its unanswered messages. So the store does not list these rows
 * (StateStore.listSessions), and `chatIdFromKey` hands a retired key back
 * whole instead of the handle inside it.
 */
const RETIRED_PREFIXES = ["trading:", "orch:"] as const;

/** True for a session key left behind by a removed feature. */
export function isRetiredSession(key: string): boolean {
  return RETIRED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export type ContactResolver = { canon: (h: string) => string };

export function sessionKeyFor(msg: InboundMessage, contacts?: ContactResolver): SessionKey {
  if (msg.isGroup) return `${PREFIX_GROUP}${msg.chatGuid}`;
  const raw = msg.fromHandle || msg.chatIdentifier;
  const canon = contacts ? contacts.canon(raw) : normalizeHandle(raw);
  return `${PREFIX_DM}${canon}`;
}

export function normalizeHandle(h: string): string {
  // IMCore labels an address with its type — "e:" for an email, "p:" for a
  // phone — and that form leaks out of it: `account` reports
  // "e:bot@example.com", and chat.db grows a second handle row for it.
  //
  // Left on, an address does not compare equal to itself. Edmund's own
  // "e:bot@example.com" did not match the configured
  // "bot@example.com", so `isOwnHandle` said no, a message it had sent
  // to itself was not recognised as its own, and it answered it as though a
  // stranger had written in — then answered that, in its own DM.
  const trimmed = h.trim().replace(/^[ep]:/i, "");
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  // E.164-ish: strip spaces, dashes, parens. Leave leading + alone.
  return trimmed.replace(/[\s\-().]/g, "");
}

export function isGroupSession(key: SessionKey): boolean {
  return key.startsWith(PREFIX_GROUP) || key.startsWith("sms:group:");
}

/** True for a plain main-persona DM session (`imessage:dm:<handle>`). Guest
 *  and vouched conversations live in this namespace — the guest-access
 *  exclusions (ghost targeting, enrollment) key off this + tier resolution. */
export function isDmSession(key: SessionKey): boolean {
  return key.startsWith(PREFIX_DM);
}

/** True for an SMS (Twilio) session key. SMS conversations live in their own
 *  namespace because their history comes from SmsStore rather than chat.db,
 *  and because the channel has a segment budget and a regulatory opt-out
 *  regime iMessage does not. See src/sms/session.ts for the full reasoning. */
export function isSmsSession(key: SessionKey | string): boolean {
  return key.startsWith("sms:dm:") || key.startsWith("sms:group:");
}

/** True for the `grok:dm:<handle>` session key the Grok connector first used.
 *  Nothing creates one now: connector requests run in the person's ordinary DM
 *  session (`imessage:dm:`), told apart by the message, not the session (see
 *  src/grok/session.ts). Kept so stale session rows, transcripts and the
 *  predicates that still test for it keep resolving. */
export function isGrokSession(key: SessionKey | string): boolean {
  return key.startsWith("grok:dm:");
}

/** True for a smart-mirror session key. The mirror is spoken aloud and drawn
 *  on glass, so it takes its own venue prompt rather than the DM one.
 *  Defined here beside the other session predicates so callers (the runner)
 *  do not have to import src/mirror/, which pulls in the whole store. */
export function isMirrorSession(key: SessionKey | string): boolean {
  return key.startsWith("mirror:");
}

/** True for a spawned sub-agent session (agent-runner workers or anything
 *  marked EDMUND_AGENT). Sub-agents must not recurse:
 *  spawn/handoff/deep-research tools register only for top-level sessions,
 *  or one "delegate this" prompt can fan out agents without a depth bound. */
export function isSubagentSession(key: SessionKey | string): boolean {
  return key.startsWith("agent:") || process.env.EDMUND_AGENT === "1";
}

/** Build the DM session key for a (normalized) handle. Mirrors sessionKeyFor. */
export function dmKeyFor(handle: string): SessionKey {
  return `${PREFIX_DM}${normalizeHandle(handle)}`;
}

export function chatIdFromKey(key: SessionKey): string {
  // SMS first: `sms:dm:` / `sms:group:` would otherwise fall through to the
  // generic return and hand callers the whole key as if it were a handle.
  if (key.startsWith("sms:dm:")) return key.slice("sms:dm:".length);
  if (key.startsWith("sms:group:")) return key.slice("sms:group:".length);
  // Legacy `grok:dm:` keys (see isGrokSession): the chat id is the person's
  // handle, so a stale row still resolves to their iMessage DM.
  if (key.startsWith("grok:dm:")) return key.slice("grok:dm:".length);
  if (key.startsWith(PREFIX_GROUP)) return key.slice(PREFIX_GROUP.length);
  if (key.startsWith(PREFIX_DM)) return key.slice(PREFIX_DM.length);
  // A retired key (isRetiredSession) falls through on purpose: the whole key
  // is not anyone's handle, so nothing built from it can reach a real chat.
  return key;
}
