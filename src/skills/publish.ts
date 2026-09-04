/**
 * Publishing a skill — one person offering their own playbook to everyone
 * else who talks to Edmund.
 *
 * Publishing is the outward-facing step in this whole subsystem. A private
 * skill is a note to self; a published one is instructions that will be read
 * on behalf of people who have never met its author. So the gate here is
 * about the AUTHOR'S RIGHT to publish and about what the text carries out
 * with it. Whether a given reader wants to use it is a separate question,
 * asked at read time by consent.ts.
 *
 * Three rules, all mechanical:
 *
 *  1. **Only the owner publishes.** Ownership is `origin_scope` — the session
 *     the skill was authored in — not `scope`, because a skill shared with
 *     everyone has a null scope and would otherwise be publishable by anyone
 *     who could see it.
 *
 *  2. **Nothing personal leaves.** The publisher may be named in their own
 *     skill; nobody else may be. See privacy.ts.
 *
 *  3. **Reversible.** Unpublishing restores the original scope and revokes
 *     every consent, so a decision made once is not permanent. An edit to a
 *     published skill revokes consent too: the yes people gave was to the
 *     text they were told about, not to whatever it becomes later.
 */

import { PERSONA_DIR } from "../claude/persona.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import { chatIdFromKey, isGroupSession } from "../sessions/key.ts";
import { revokeConsentFor } from "./consent.ts";
import { type InstallRecord, categoryOf, readDb, writeDb } from "./installer.ts";
import { describeLeaks, findLeaks } from "./privacy.ts";

export type PublishResult = { ok: true; record: InstallRecord } | { ok: false; reason: string };

export type PublishInput = {
  name: string;
  /** Session asking to publish. Must be where the skill was authored. */
  sessionKey: string;
  dbPath: string;
  consentDbPath: string;
  /** Full SKILL.md text, for the leak scan. */
  skillText: string;
  /** The assistant's own names — allowed to appear in a skill about itself. */
  selfNames?: string[];
  contacts: ContactBook;
};

export function publishSkill(input: PublishInput): PublishResult {
  const { name, sessionKey, dbPath } = input;
  const db = readDb(dbPath);
  const record = db.skills[name];
  if (!record) {
    return {
      ok: false,
      reason: `${name} is not a managed skill — only a skill you authored here can be published`,
    };
  }
  if (record.disabled) return { ok: false, reason: `${name} is disabled by the operator` };

  const category = categoryOf(record);
  if (category === "public") return { ok: false, reason: `${name} is already published` };
  if (category !== "self") {
    return {
      ok: false,
      reason: `${name} came from ${record.source} — you can only publish a skill authored in this chat`,
    };
  }

  // A group has no single author to attribute a skill to, and "published by
  // the room" is not something the consent ask can name. Publishing is a
  // personal act; it happens in a DM.
  if (isGroupSession(sessionKey)) {
    return {
      ok: false,
      reason: "publish from a direct message — a published skill is attributed to one person",
    };
  }

  const owner = record.origin_scope ?? record.scope;
  if (!owner) {
    return {
      ok: false,
      reason: `${name} predates authorship tracking, so there is no record of who wrote it — re-create it here and publish that`,
    };
  }
  if (owner !== sessionKey) {
    return {
      ok: false,
      reason: `${name} was authored in another chat — only its author can publish it`,
    };
  }

  const publisher = input.contacts.canon(chatIdFromKey(sessionKey));
  const publisherName = input.contacts.displayName(publisher) ?? publisher;

  // The publisher may name themselves. Everyone else in the book may not.
  const allow = [
    publisherName,
    publisher,
    ...input.contacts.aliasesFor(publisher),
    ...(input.selfNames ?? []),
  ];
  const leaks = findLeaks(input.skillText, input.contacts, allow, { personaDir: PERSONA_DIR });
  if (leaks.length > 0) {
    return {
      ok: false,
      reason: `${name} still carries details from this conversation: ${describeLeaks(leaks)}. Rewrite it so it reads as instructions for a stranger, then publish.`,
    };
  }

  record.category = "public";
  record.origin_scope = owner;
  record.scope = null;
  record.publisher = publisher;
  record.publisher_name = publisherName;
  record.published_at = Date.now();
  writeDb(dbPath, db);
  // A fresh publication starts with a clean slate — no consent inherited from
  // an earlier publication of the same name.
  revokeConsentFor(name, input.consentDbPath);
  return { ok: true, record };
}

export function unpublishSkill(args: {
  name: string;
  sessionKey: string;
  dbPath: string;
  consentDbPath: string;
}): PublishResult {
  const db = readDb(args.dbPath);
  const record = db.skills[args.name];
  if (!record) return { ok: false, reason: `not a managed skill: ${args.name}` };
  if (categoryOf(record) !== "public")
    return { ok: false, reason: `${args.name} is not published` };
  if (record.origin_scope !== args.sessionKey) {
    return {
      ok: false,
      reason: `only ${record.publisher_name ?? "its author"} can unpublish ${args.name}`,
    };
  }

  record.category = "self";
  record.scope = record.origin_scope;
  record.publisher = null;
  record.publisher_name = null;
  record.published_at = null;
  writeDb(args.dbPath, db);
  revokeConsentFor(args.name, args.consentDbPath);
  return { ok: true, record };
}
