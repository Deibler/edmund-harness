/**
 * Consent for published skills.
 *
 * A "public" skill is one person's playbook offered to everyone else. Reading
 * it puts a stranger's instructions into the model's context for someone who
 * never asked for them, so the first use in any conversation has to be
 * confirmed out loud:
 *
 *   "There's a skill for this from Sam — want me to use it?"
 *
 * Two things make that a real gate rather than a request:
 *
 *  1. **The body is withheld, not the reminder.** `read_skill` on an
 *     unconsented public skill returns the consent stub INSTEAD of the
 *     SKILL.md. The instructions cannot reach the model's context by being
 *     forgotten about, because they are never sent. A prompt rule saying
 *     "please ask first" is a comment, and a comment cannot hold an
 *     invariant.
 *
 *  2. **Consent needs a human turn.** `recordDecision` refuses unless the
 *     session has received an inbound message SINCE the stub was served.
 *     Without that, a model could serve itself the stub and answer its own
 *     question inside one turn, and the ask would be theatre. The proof is
 *     `sessions.last_inbound_ms` in state.db — a keyed source the consent
 *     path does not control.
 *
 * The group rule is the operator's, and it is about who is in the room: if
 * the publisher is a participant, their own presence is the introduction and
 * no confirmation is needed. Ask only when the room is using someone's skill
 * behind their back.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatDb } from "../imessage/db.ts";
import { getGroupParticipants } from "../imessage/participants.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import {
  type SessionKey,
  chatIdFromKey,
  isGroupSession,
  normalizeHandle,
} from "../sessions/key.ts";
import { type InstallRecord, categoryOf } from "./installer.ts";

export type ConsentDecision = "allow" | "deny";

export type ConsentEntry = {
  decision: ConsentDecision;
  at_ms: number;
  /** Session that answered — recorded so an audit can see who allowed what. */
  session_key: SessionKey;
};

export type ConsentDb = {
  version: 1;
  /** When a consent stub was last served, keyed skill|session. */
  asks: Record<string, { asked_at_ms: number }>;
  /** Answers, keyed skill|session. */
  decisions: Record<string, ConsentEntry>;
};

function key(skill: string, session: SessionKey): string {
  return `${skill}|${session}`;
}

export function readConsentDb(path: string): ConsentDb {
  if (!existsSync(path)) return { version: 1, asks: {}, decisions: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ConsentDb;
    if (parsed.version !== 1) return { version: 1, asks: {}, decisions: {} };
    return { version: 1, asks: parsed.asks ?? {}, decisions: parsed.decisions ?? {} };
  } catch {
    return { version: 1, asks: {}, decisions: {} };
  }
}

export function writeConsentDb(path: string, db: ConsentDb): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(db, null, 2));
}

export type ConsentDeps = {
  chatDb: ChatDb;
  contacts: ContactBook;
  /** chat.guid values belonging to this session. Groups have exactly one. */
  chatGuids: string[];
  consentDbPath: string;
};

export type ConsentState =
  | { required: false; reason: "not-public" | "publisher-present" | "own-skill" | "allowed" }
  | { required: true; reason: "never-asked" | "previously-declined"; publisherName: string };

/**
 * Does this session need to confirm before the body of `record` is read?
 *
 * Pure decision — serving the stub and stamping the ask is `serveAsk`, so a
 * caller that only wants to know (list_skills annotating a row, a test) does
 * not accidentally record one.
 */
export function consentState(
  record: InstallRecord | undefined,
  sessionKey: SessionKey,
  deps: ConsentDeps,
): ConsentState {
  if (categoryOf(record) !== "public" || !record) return { required: false, reason: "not-public" };

  const publisher = record.publisher ? normalizeHandle(record.publisher) : null;
  // A public record with no publisher cannot name anyone in the ask, and an
  // ask that cannot say whose skill it is defeats the point. Treat it as
  // ungated rather than blocking on a question we can't phrase — publishing
  // always writes a publisher, so this is a corrupt-row path only.
  if (!publisher) return { required: false, reason: "not-public" };

  const publisherName = record.publisher_name?.trim() || publisher;

  if (publisherIsPresent(publisher, sessionKey, deps)) {
    return {
      required: false,
      reason: isGroupSession(sessionKey) ? "publisher-present" : "own-skill",
    };
  }

  const decision = readConsentDb(deps.consentDbPath).decisions[key(record.name, sessionKey)];
  if (decision?.decision === "allow") return { required: false, reason: "allowed" };
  return {
    required: true,
    reason: decision?.decision === "deny" ? "previously-declined" : "never-asked",
    publisherName,
  };
}

/**
 * Is the person who published this skill in the conversation?
 *
 * In a DM that means the skill is the requester's own. In a group it means
 * they are a participant — the operator's rule: confirmation is only needed
 * when the publisher is NOT in the room.
 *
 * chat.db is asked for participants every call rather than cached. A group's
 * membership changes, and a cached roster would keep answering "they're
 * here" for someone who left.
 */
function publisherIsPresent(publisher: string, sessionKey: SessionKey, deps: ConsentDeps): boolean {
  const canon = (h: string) => normalizeHandle(deps.contacts.canon(h));
  const publisherCanon = canon(publisher);

  if (!isGroupSession(sessionKey)) {
    return canon(chatIdFromKey(sessionKey)) === publisherCanon;
  }

  for (const guid of deps.chatGuids) {
    for (const h of getGroupParticipants(deps.chatDb, guid)) {
      if (canon(h) === publisherCanon) return true;
    }
  }
  return false;
}

/**
 * Stamp that the ask has been put to this session, and return the words the
 * model should say. Called only from the read path, so an ask is recorded
 * exactly when the body was withheld.
 */
export function serveAsk(
  record: InstallRecord,
  sessionKey: SessionKey,
  state: Extract<ConsentState, { required: true }>,
  deps: ConsentDeps,
): string {
  const db = readConsentDb(deps.consentDbPath);
  db.asks[key(record.name, sessionKey)] = { asked_at_ms: Date.now() };
  writeConsentDb(deps.consentDbPath, db);

  const declined =
    state.reason === "previously-declined"
      ? "\n\nThey declined this once before. Only raise it again if they brought it up themselves — if this is you retrying on your own, drop it and solve the problem another way."
      : "";

  return [
    `[CONSENT REQUIRED — the instructions for "${record.name}" were NOT loaded]`,
    "",
    `This is a skill ${state.publisherName} published for other people to use. It is someone else's playbook, and this conversation has never agreed to it, so ask before you read it. In your own words, something like:`,
    "",
    `    "There's a skill for this from ${state.publisherName} — want me to use it?"`,
    "",
    "Ask, then STOP and let them answer. Do not describe what the skill does — you have not read it. Do not answer for them.",
    "",
    `When they reply, call \`confirm_skill_use(name: "${record.name}", decision: "allow" | "deny")\`. On allow, \`read_skill\` will return the real instructions. On deny, solve the problem without it and do not bring it up again.`,
    declined,
  ].join("\n");
}

export type RecordResult = { ok: true } | { ok: false; reason: string };

/**
 * Record the person's answer.
 *
 * `lastInboundMs` is the session's last inbound timestamp from state.db. It
 * must be later than the ask: that is the evidence a human actually spoke
 * between the question and the answer. Passing null (no session row yet)
 * fails closed — a session that has never received a message cannot have
 * answered anything.
 */
export function recordDecision(args: {
  skillName: string;
  sessionKey: SessionKey;
  decision: ConsentDecision;
  lastInboundMs: number | null;
  consentDbPath: string;
}): RecordResult {
  const db = readConsentDb(args.consentDbPath);
  const k = key(args.skillName, args.sessionKey);
  const ask = db.asks[k];
  if (!ask) {
    return {
      ok: false,
      reason: `nobody has been asked about "${args.skillName}" in this chat — call read_skill first, which puts the question to them`,
    };
  }
  if (args.lastInboundMs === null || args.lastInboundMs <= ask.asked_at_ms) {
    return {
      ok: false,
      reason:
        "they have not answered yet — the last message in this chat predates the question. Ask, send it, and record their answer on the turn their reply arrives.",
    };
  }

  db.decisions[k] = {
    decision: args.decision,
    at_ms: Date.now(),
    session_key: args.sessionKey,
  };
  // The ask is spent. A later re-ask has to serve a fresh stub, which is what
  // keeps a stale "yes" from being replayed against a question asked months
  // ago about a skill that has since been rewritten.
  delete db.asks[k];
  writeConsentDb(args.consentDbPath, db);
  return { ok: true };
}

/** Forget every decision about one skill — used when it is unpublished or
 *  its contents change enough that the old yes no longer describes it. */
export function revokeConsentFor(skillName: string, consentDbPath: string): void {
  const db = readConsentDb(consentDbPath);
  const prefix = `${skillName}|`;
  for (const k of Object.keys(db.decisions)) if (k.startsWith(prefix)) delete db.decisions[k];
  for (const k of Object.keys(db.asks)) if (k.startsWith(prefix)) delete db.asks[k];
  writeConsentDb(consentDbPath, db);
}
