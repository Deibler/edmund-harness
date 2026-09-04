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
 * Trading sub-persona namespace. A DM from one of the trading handles that
 * has switched into the trading persona is keyed here instead of the normal
 * `imessage:dm:` namespace, so it gets the trading loadout (persona +
 * mcp-trading.json) everywhere downstream — persona load, system prompt,
 * MCP-config selection, sandbox slug, and cron-fire target — automatically.
 */
const PREFIX_TRADING_DM = "trading:dm:";
/**
 * Named-orchestrator namespace. A message that invokes a configured
 * orchestrator by name ("desmond, ...") is keyed `orch:<okey>:dm:<handle>`
 * or `orch:<okey>:group:<chatGuid>` so that persona, model, MCP env, sandbox
 * and history scope all resolve per-orchestrator — exactly the same trick as
 * the trading namespace, generalized. The built-in main persona keeps the
 * legacy un-prefixed `imessage:` keys so existing session memory survives.
 */
const PREFIX_ORCH = "orch:";

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
  return (
    key.startsWith(PREFIX_GROUP) ||
    key.startsWith("sms:group:") ||
    (key.startsWith(PREFIX_ORCH) && key.includes(":group:"))
  );
}

/** True for a plain main-persona DM session (`imessage:dm:<handle>`). Guest
 *  and vouched conversations live in this namespace — the guest-access
 *  exclusions (ghost targeting, enrollment) key off this + tier resolution. */
export function isDmSession(key: SessionKey): boolean {
  return key.startsWith(PREFIX_DM);
}

/** True for a trading sub-persona session key. Trading is DM-only. */
export function isTradingSession(key: SessionKey): boolean {
  return key.startsWith(PREFIX_TRADING_DM);
}

/** True for an SMS (Twilio) session key. SMS conversations live in their own
 *  namespace because their history comes from SmsStore rather than chat.db,
 *  and because the channel has a segment budget and a regulatory opt-out
 *  regime iMessage does not. See src/sms/session.ts for the full reasoning. */
export function isSmsSession(key: SessionKey | string): boolean {
  return key.startsWith("sms:dm:") || key.startsWith("sms:group:");
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

/** Build the trading session key for a (normalized) handle. */
export function tradingKeyFor(handle: string): SessionKey {
  return `${PREFIX_TRADING_DM}${normalizeHandle(handle)}`;
}

/** Build the DM session key for a (normalized) handle. Mirrors sessionKeyFor. */
export function dmKeyFor(handle: string): SessionKey {
  return `${PREFIX_DM}${normalizeHandle(handle)}`;
}

/** Build the session key for a named orchestrator. Mirrors sessionKeyFor. */
export function orchKeyFor(
  orchKey: string,
  msg: InboundMessage,
  contacts?: ContactResolver,
): SessionKey {
  if (msg.isGroup) return `${PREFIX_ORCH}${orchKey}:group:${msg.chatGuid}`;
  const raw = msg.fromHandle || msg.chatIdentifier;
  const canon = contacts ? contacts.canon(raw) : normalizeHandle(raw);
  return `${PREFIX_ORCH}${orchKey}:dm:${canon}`;
}

/**
 * Which orchestrator owns this session?
 *  - `orch:<okey>:…`  → that orchestrator
 *  - `imessage:…`     → "main" (the built-in persona)
 *  - anything else (trading, cron, …) → null: not part of the named-
 *    orchestrator world; callers treat it as exempt from visibility rules.
 */
export function orchestratorOfSession(key: SessionKey): string | null {
  if (key.startsWith(PREFIX_ORCH)) {
    const rest = key.slice(PREFIX_ORCH.length);
    const cut = rest.indexOf(":");
    return cut > 0 ? rest.slice(0, cut) : null;
  }
  if (key.startsWith(PREFIX_DM) || key.startsWith(PREFIX_GROUP)) return "main";
  return null;
}

export function chatIdFromKey(key: SessionKey): string {
  // SMS first: `sms:dm:` / `sms:group:` would otherwise fall through to the
  // generic return and hand callers the whole key as if it were a handle.
  if (key.startsWith("sms:dm:")) return key.slice("sms:dm:".length);
  if (key.startsWith("sms:group:")) return key.slice("sms:group:".length);
  if (key.startsWith(PREFIX_GROUP)) return key.slice(PREFIX_GROUP.length);
  if (key.startsWith(PREFIX_TRADING_DM)) return key.slice(PREFIX_TRADING_DM.length);
  if (key.startsWith(PREFIX_DM)) return key.slice(PREFIX_DM.length);
  if (key.startsWith(PREFIX_ORCH)) {
    const rest = key.slice(PREFIX_ORCH.length);
    const m = rest.match(/^[^:]+:(?:dm|group):(.*)$/);
    if (m) return m[1]!;
  }
  return key;
}
