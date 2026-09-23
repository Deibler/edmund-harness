/**
 * Household registry: which chats belong to which kitchen, and its settings.
 *
 * An account is a household (one kitchen and the people sharing it), not a
 * person. Each has its own files under `tenants/<id>/`, so no read can span two.
 *
 * Resolution order: explicit id, then env, then the calling session's
 * membership, then an error. There is no default account: reading one
 * household's kitchen for a stranger is worse than failing.
 *
 * Everything after `members` is optional; unset preferences are derived from
 * the log and labelled as derived.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Account, Registry } from "./types.ts";

export const DEFAULT_DIR = resolve(process.env.EDMUND_DATA_DIR ?? "./data", "kitchen");

/** Set from `[kitchen] dir` when the tools are built. Env still wins over it. */
let configured: string | null = null;

/** Point this process at a different data directory (from config). */
export function useKitchenDir(dir: string | null | undefined): void {
  configured = dir?.trim() ? dir : null;
}

/**
 * Where the ledgers live, resolved on every call. A module-scope constant would
 * bind at import time, before a test could set KITCHEN_DIR, and point tests at
 * real data.
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
  // No replacer argument: a key array there is a recursive whitelist and once
  // stripped every account field. Write-then-rename keeps a crash from leaving a
  // half-written registry.
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
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

/** The caller's chat session from the environment; an empty value is no identity. */
export function principal(): string | null {
  const p = process.env.KITCHEN_PRINCIPAL || process.env.EDMUND_SESSION_KEY;
  return p?.trim() ? p : null;
}

/**
 * How many people eat from this kitchen: direct-message members only, at least
 * one. A group chat is a channel to the household, not another eater.
 */
export function eaterCount(acct: Account): number {
  return Math.max(1, eaters(acct).length);
}

/**
 * The household's people (group chats excluded) with a display label: the name
 * in `people` when set, otherwise a formatted handle.
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
 * The household's title, e.g. "Sam and Alex's Kitchen", from the named people.
 * Falls back to the account name when nobody is named.
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
 * Bind a call to exactly one household, or throw a message written for the
 * model: the recovery is to ask a person whose kitchen it is, never to guess.
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
    // An explicit id selects among the caller's own kitchens; it never reaches
    // past them. An unidentified caller is refused too, not promoted.
    // KITCHEN_ADMIN=1 is the deliberate escape for operator work.
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
  // No household: the message doubles as the onboarding offer, since every
  // session without a kitchen reaches it.
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
  // A principal belongs to at most one household, on every write path.
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

/** Add a member. A principal belongs to at most one household. */
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
  // Refuse rather than silently succeed, so a mistyped handle is noticed.
  if (!acct.members.includes(who)) {
    throw new Error(`${who} is not a member of "${id}"; nothing to remove.`);
  }
  acct.members = acct.members.filter((m) => m !== who);
  saveRegistry(reg);
  return acct;
}

/** Shallow-merge settings. Absent keys stay absent, so derived values stay derived. */
export function updateAccount(id: string, patch: Partial<Account>): Account {
  const reg = loadRegistry();
  const acct = reg.tenants[id];
  if (!acct) throw new Error(`No household "${id}".`);
  // Merge a sub-object only when one side has one; an empty `{}` would read as
  // "set" and hide the derived default.
  const sub = <K extends "diet" | "schedule" | "site">(k: K) =>
    acct[k] || patch[k] ? { [k]: { ...(acct[k] ?? {}), ...(patch[k] ?? {}) } } : {};
  const merged: Account = {
    ...acct,
    ...patch,
    ...sub("diet"),
    ...sub("schedule"),
    ...sub("site"),
    // Membership changes only through join/leave.
    members: acct.members,
  };
  reg.tenants[id] = merged;
  saveRegistry(reg);
  return merged;
}
