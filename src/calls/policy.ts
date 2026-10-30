/**
 * Who Edmund may call, and whose calls he answers: one rule for both
 * directions, read from [facetime] allow/deny.
 *
 *  - Empty `allow` admits nobody. A config that names no one is not a config
 *    that means everyone (the same fail-closed rule as [security]).
 *  - `deny` wins over everything.
 *  - "operator" means the [security] operator handles.
 *  - "contacts" means anyone his contacts name (config contacts or the macOS
 *    address book) — "any of his contacts", made explicit.
 *  - Anything else is a handle (compared canonically, so a person's phone and
 *    email are one entry) or a group chat GUID.
 *
 * Asking someone else to be called is a separate question from whether they
 * may be called at all: see `mayRequestCall`.
 */

import type { Config } from "../config/config.ts";
import { operatorHandles, tierForSessionKey } from "../security/policy.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";

export type CallTarget = { kind: "person"; handle: string } | { kind: "group"; chatGuid: string };

export type Permission = { allowed: true } | { allowed: false; reason: string };

type Contacts = Pick<ContactBook, "canon" | "displayName">;

/** A group chat GUID ("iMessage;+;chat123…", "any;+;…"), as opposed to a handle. */
function isGroupGuid(entry: string): boolean {
  return /;\+;/.test(entry);
}

type Rules = { handles: Set<string>; groups: Set<string>; contacts: boolean };

function compile(entries: string[], config: Config, contacts: Contacts): Rules {
  const rules: Rules = { handles: new Set(), groups: new Set(), contacts: false };
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === "contacts") rules.contacts = true;
    else if (entry === "operator") {
      for (const handle of operatorHandles(config)) rules.handles.add(contacts.canon(handle));
    } else if (isGroupGuid(entry)) rules.groups.add(entry);
    else rules.handles.add(contacts.canon(entry));
  }
  return rules;
}

export class CallPolicy {
  private readonly allow: Rules;
  private readonly deny: Rules;

  constructor(
    config: Config,
    private readonly contacts: Contacts,
  ) {
    this.allow = compile(config.facetime.allow, config, contacts);
    this.deny = compile(config.facetime.deny, config, contacts);
  }

  permits(target: CallTarget): Permission {
    if (target.kind === "group") {
      if (this.deny.groups.has(target.chatGuid))
        return { allowed: false, reason: "group is denied" };
      return this.allow.groups.has(target.chatGuid)
        ? { allowed: true }
        : { allowed: false, reason: "group is not on the FaceTime allow list" };
    }
    const handle = this.contacts.canon(target.handle);
    const isContact = this.contacts.displayName(handle) !== null;
    if (this.deny.handles.has(handle) || (this.deny.contacts && isContact)) {
      return { allowed: false, reason: "person is denied" };
    }
    if (this.allow.handles.has(handle) || (this.allow.contacts && isContact))
      return { allowed: true };
    return { allowed: false, reason: "person is not on the FaceTime allow list" };
  }
}

/**
 * May the conversation `requester` ask for a call to `callee`'s conversation?
 *
 * Someone asking Edmund to call them is always fine. Asking him to call
 * somebody else is the same power as messaging somebody else, so it takes the
 * operator tier, exactly as message_contact does.
 */
export function mayRequestCall(
  config: Config,
  requester: SessionKey,
  callee: SessionKey,
): Permission {
  if (requester === callee) return { allowed: true };
  return tierForSessionKey(config, requester) === "operator"
    ? { allowed: true }
    : { allowed: false, reason: "only the operator can ask Edmund to call someone else" };
}
