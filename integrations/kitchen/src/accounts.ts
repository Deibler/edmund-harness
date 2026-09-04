/**
 * Account registry: who owns which kitchen, and what that household prefers.
 *
 * An account is one household — one kitchen's food plus the people sharing it.
 * Not one person: two people with one fridge must share one ledger or both
 * their answers are fiction. Isolation is structural (a file per account under
 * `tenants/<id>/`), so no read can span two and there is nothing to remember
 * to scope.
 *
 * Resolution is: explicit id, then env, then the calling chat session's
 * membership, then a hard failure. There is deliberately no default account.
 * Quietly reading one household's fridge for a stranger is a worse outcome
 * than an error, so this module never guesses and offers no `--force`.
 *
 * Everything past `members` — budget, stores, diet, schedule, site — is
 * optional with a working default. Nothing in this integration may require a
 * setup form; a preference that has never been set is *derived* from the log
 * (see `insights.ts`) and clearly labelled as derived.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Account, Registry } from "./types.ts";

export const DEFAULT_DIR = resolve(process.env.EDMUND_DATA_DIR ?? "./data", "kitchen");

/** Set from `[kitchen] dir` when the tools are built. Env still wins over it. */
let configured: string | null = null;

/** Point this process at a different data directory. Called once, from config. */
export function useKitchenDir(dir: string | null | undefined): void {
  configured = dir?.trim() ? dir : null;
}

/**
 * Where the ledgers live, resolved on every call.
 *
 * Deliberately a function, not a const. A module-scope `join(BASE, ...)` binds
 * the moment the module is imported, and an ES import hoists above any
 * assignment in the importing file — so a test that sets KITCHEN_DIR and then
 * imports this got the REAL data directory, and a second test file in the same
 * process silently inherited the first one's temp dir. Both happened. Resolving
 * per call costs nothing and removes the whole class.
 */
export function baseDir(): string {
  return process.env.KITCHEN_DIR || configured || DEFAULT_DIR;
}

export function registryPath(): string {
  return join(baseDir(), "tenants.json");
}

export function accountDir(): string {
  return join(baseDir(), "tenants");
}

export function logPath(account: string): string {
  return join(accountDir(), account, "events.jsonl");
}

export function idOk(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(id);
}

export function loadRegistry(): Registry {
  if (!existsSync(registryPath())) return { version: 1, tenants: {} };
  return JSON.parse(readFileSync(registryPath(), "utf8")) as Registry;
}

export function saveRegistry(reg: Registry): void {
  if (!reg || typeof reg !== "object" || !reg.tenants) {
    throw new Error("refusing to write a malformed registry");
  }
  mkdirSync(baseDir(), { recursive: true });
  const registry = registryPath();
  const tmp = `${registry}.tmp`;
  // NB: no replacer argument. `JSON.stringify(reg, Object.keys(reg), 2)` reads
  // like key ordering and is actually a recursive property WHITELIST — it once
  // stripped every field not named "version" or "tenants" from every account
  // and emptied this file. Sorting, if ever wanted, belongs in a comparator on
  // the object, never in the second parameter.
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  // Write-then-rename so a crash mid-write can never leave a half-parsed
  // registry, which would lock every household out of its own kitchen.
  renameSync(tmp, registry);
}

export function getAccount(id: string): Account | null {
  return loadRegistry().tenants[id] ?? null;
}

export function listAccounts(): Array<{ id: string } & Account> {
  const reg = loadRegistry();
  return Object.entries(reg.tenants)
    .map(([id, a]) => ({ id, ...a }))
    .sort((x, y) => x.id.localeCompare(y.id));
}

/** Who is asking. The chat session is the identity the harness already holds. */
export function principal(): string | null {
  // An env var set to "" is absent, not an identity. `??` keeps the empty string,
  // which then reads as a real principal named "" — falsy everywhere it is
  // checked, but printed into error messages as nothing at all, and matched
  // against members lists as a value someone could conceivably be registered as.
  const p = process.env.KITCHEN_PRINCIPAL || process.env.EDMUND_SESSION_KEY;
  return p?.trim() ? p : null;
}

/**
 * How many PEOPLE eat out of this kitchen.
 *
 * Not `members.length`. A member is a principal — a way of reaching the
 * household — and a group chat is a channel, not a mouth. Binding the
 * a couple's group chat to their household made the site say "shared by 3 people"
 * and quietly divided every calorie figure by three. Count DM principals only,
 * and never go below one.
 */
export function eaterCount(acct: Account): number {
  return Math.max(1, eaters(acct).length);
}

/**
 * The people, as pickable identities.
 *
 * Same filter as `eaterCount` — a group chat is a channel, not a mouth — but
 * this keeps the principal so the site can offer "who should get this recipe"
 * and hand the answer back as something messageable. The label is derived
 * rather than stored, because a display name is a setting and the product rule
 * is that no feature may require a setup form to work.
 */
export function eaters(acct: Account): Array<{ principal: string; label: string }> {
  return acct.members
    .filter((m) => !m.startsWith("imessage:group:"))
    .map((principal) => ({
      principal,
      label: acct.people?.[principal] ?? labelFor(principal),
    }));
}

/**
 * What to call this kitchen.
 *
 * "Sam and Alex's Kitchen" beats "13 Example Court" because a household
 * is people, not an address — and the address is the one thing on this page
 * nobody living there needs to be told. Falls back to the account name when
 * nobody is named yet, so this degrades to the old behaviour instead of to a
 * blank.
 */
export function householdTitle(acct: Account): string {
  const named = eaters(acct)
    .map((e) => acct.people?.[e.principal])
    .filter((n): n is string => Boolean(n));
  if (!named.length) return `${acct.name} Kitchen`;
  const list =
    named.length === 1
      ? named[0]!
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  // "Chris" -> "Chris'", everyone else -> "'s"
  const poss = list.endsWith("s") ? `${list}'` : `${list}'s`;
  return `${poss} Kitchen`;
}

function labelFor(p: string): string {
  const tail = p.split(":").pop() ?? p;
  const digits = tail.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return tail;
}

export function accountForPrincipal(p: string, reg?: Registry): string | null {
  const r = reg ?? loadRegistry();
  for (const id of Object.keys(r.tenants).sort()) {
    if (r.tenants[id]!.members.includes(p)) return id;
  }
  return null;
}

export class NoAccountError extends Error {}

/**
 * Bind a call to exactly one household.
 *
 * The failure message is written for the model that will read it, because the
 * correct recovery is a question to a human ("whose kitchen?") and never a
 * guess at one.
 */
export function resolveAccount(explicit?: string | null, sessionKey?: string | null): string {
  const asked = explicit || process.env.KITCHEN_TENANT || null;
  const p = (sessionKey?.trim() ? sessionKey : null) ?? principal();
  const id = asked || (p ? accountForPrincipal(p) : null);
  if (id) {
    const reg = loadRegistry();
    const acct = reg.tenants[id];
    if (!acct) {
      throw new NoAccountError(
        `No household called "${id}". Use kitchen_accounts to see what exists, or create it with kitchen_accounts action=create.`,
      );
    }
    // An explicit id DISAMBIGUATES among kitchens you belong to; it is not a way
    // to reach past them. Honouring it unchecked made the whole isolation story
    // advisory — a session in no household could read and write any ledger just
    // by naming it. KITCHEN_ADMIN=1 is the deliberate escape for migration and
    // operator work, and has to be set on purpose.
    //
    // The check has to run when the caller is UNKNOWN too, not only when it is
    // known and wrong. Gating on `p` meant an unset EDMUND_SESSION_KEY silently
    // promoted any caller to operator — the weakest possible identity got the
    // strongest access, which is the wrong way round. No identity plus a named
    // kitchen is now a refusal like any other.
    if (asked && process.env.KITCHEN_ADMIN !== "1" && (!p || !acct.members.includes(p))) {
      const mine = p ? accountForPrincipal(p, reg) : null;
      throw new NoAccountError(
        `${p ?? "An unidentified caller"} is not a member of "${id}", so it cannot read or write that kitchen. ${
          mine
            ? `This session belongs to "${mine}" — omit the account argument to use it.`
            : p
              ? `This session belongs to no household yet.`
              : `No chat session identified this caller at all.`
        } Crossing households requires KITCHEN_ADMIN=1, set on purpose.`,
      );
    }
    return id;
  }
  // This message is the front door. Somebody reaching a kitchen tool with no
  // household is not an error case to report and move past — it is the exact
  // moment the whole thing is worth offering, and the reply they get should be
  // an offer rather than an apology. Every session hits this text, so the
  // routing lives here rather than in a habit I might not have.
  throw new NoAccountError(
    `No kitchen is registered for ${p ?? "(unknown caller)"}.\n\nDo not route around this and do not answer their food question from nothing. It means nobody has said whose kitchen this is, and reading someone else's would be worse than failing.\n\nIf they have asked about food more than once, OFFER: you can keep answering from nothing, or you can track what is actually in their kitchen and answer from that — what is cookable tonight, what is about to turn, what they spend. Setup is two photos and one question. Then kitchen_onboard action:"check" for the exact next move, and action:"start" once they say yes.\n\nIf they belong in an existing household instead, kitchen_accounts action:"join".`,
  );
}

export function createAccount(
  id: string,
  opts: { name?: string; members?: string[]; note?: string } = {},
): Account {
  if (!idOk(id)) {
    throw new Error(
      `Household id must be lowercase letters, digits and dashes, 2-32 chars: "${id}"`,
    );
  }
  const reg = loadRegistry();
  if (reg.tenants[id]) throw new Error(`Household "${id}" already exists.`);
  // The same one-household invariant joinAccount enforces. Skipping it here let
  // a principal land in two kitchens, and accountForPrincipal then resolved it
  // to whichever id sorted first — so which fridge you got depended on
  // alphabetical order. An invariant enforced on one write path is not one.
  for (const who of opts.members ?? []) {
    const other = Object.entries(reg.tenants).find(([, v]) => v.members.includes(who));
    if (other) {
      throw new Error(
        `${who} already belongs to "${other[0]}". Leave that first — a principal in two kitchens is exactly how ledgers get mixed.`,
      );
    }
  }
  const acct: Account = {
    name: opts.name || id,
    created: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    members: [...new Set(opts.members ?? [])].sort(),
    note: opts.note ?? null,
  };
  reg.tenants[id] = acct;
  saveRegistry(reg);
  mkdirSync(dirname(logPath(id)), { recursive: true });
  if (!existsSync(logPath(id))) writeFileSync(logPath(id), "");
  return acct;
}

/** A principal belongs to at most one household — two is how ledgers get mixed. */
export function joinAccount(id: string, who: string): Account {
  const reg = loadRegistry();
  const acct = reg.tenants[id];
  if (!acct) throw new Error(`No household "${id}".`);
  const other = Object.entries(reg.tenants).find(([t, v]) => t !== id && v.members.includes(who));
  if (other) {
    throw new Error(
      `${who} already belongs to "${other[0]}". Leave that first — a principal in two kitchens is exactly how ledgers get mixed.`,
    );
  }
  acct.members = [...new Set([...acct.members, who])].sort();
  saveRegistry(reg);
  return acct;
}

export function leaveAccount(id: string, who: string): Account {
  const reg = loadRegistry();
  const acct = reg.tenants[id];
  if (!acct) throw new Error(`No household "${id}".`);
  // Silently succeeding reads as "removed" and hides a typo'd handle, leaving
  // the real principal still a member.
  if (!acct.members.includes(who)) {
    throw new Error(`${who} is not a member of "${id}"; nothing to remove.`);
  }
  acct.members = acct.members.filter((m) => m !== who);
  saveRegistry(reg);
  return acct;
}

/** Shallow-merge settings. Absent keys stay absent so "derived" stays derived. */
export function updateAccount(id: string, patch: Partial<Account>): Account {
  const reg = loadRegistry();
  const acct = reg.tenants[id];
  if (!acct) throw new Error(`No household "${id}".`);
  // Merge a sub-object only when one side actually has one. Building `{}`
  // unconditionally turned "never set" into "set to nothing", so `acct.diet`
  // became truthy for a household that has never expressed a preference and the
  // derived-value path stopped being reachable.
  const sub = <K extends "diet" | "schedule" | "site">(k: K) =>
    acct[k] || patch[k] ? { [k]: { ...(acct[k] ?? {}), ...(patch[k] ?? {}) } } : {};
  const merged: Account = {
    ...acct,
    ...patch,
    ...sub("diet"),
    ...sub("schedule"),
    ...sub("site"),
    // Membership has its own guarded path; a settings patch must never
    // silently move people between households.
    members: acct.members,
  };
  reg.tenants[id] = merged;
  saveRegistry(reg);
  return merged;
}
