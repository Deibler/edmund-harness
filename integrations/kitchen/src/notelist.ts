/**
 * What each household's shared Apple Note should say, and when to ask Edmund
 * to make it say so.
 *
 * Edmund edits the note himself, on screen, with the computer-use tools: the
 * Notes app on this Mac, one changed line at a time, the way a person would.
 * Nothing in the kitchen writes to a note. This module only decides.
 *
 *   - `noteLines` is the list as the note should read: the title, then a
 *     heading and checklist lines per group. Pure, so the part that could lose
 *     somebody's shopping list stays under unit test.
 *   - `noteDue` says when a household's list has changed since Edmund last
 *     brought its note up to date and has then held still for SETTLE_MS, so a
 *     burst of taps on the site becomes one wake rather than five.
 *   - `markNoteWritten` is Edmund saying he has done it
 *     (`kitchen_shopping noteWritten:true`), which is what stops the next wake.
 *   - `canEditNotes` asks the computer-use policy whether a chat would get
 *     Notes at all, so no turn is spent waking a chat that cannot do the edit.
 *
 * The signature covers the list's lines only. Ticks and timestamps are not
 * the list changing, and waking a session to rework a note somebody is
 * shopping from is the worst thing this could do.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import { sessionPolicy } from "../../../src/mcp/computer-use/policy.ts";
import { tierForSessionKey } from "../../../src/security/policy.ts";
import { accountDir, getAccount, householdTitle, updateAccount } from "./accounts.ts";
import { shopping } from "./shopping.ts";

/**
 * The line that ends the part of the note Edmund keeps. Anything below it was
 * typed by the household and is theirs; Edmund moves new items from there
 * onto the list.
 */
export const SENTINEL = "Add anything below this line and I will move it onto the list above.";

/** How long a changed list must hold still before Edmund is woken for it. */
export const SETTLE_MS = 2 * 60_000;

export type NoteLine = { kind: "title" | "heading" | "item" | "text"; text: string };

/**
 * The note's title: the one pinned on the household, else one derived from
 * its name. A derived title follows the people, so naming somebody would
 * point the kitchen (and the screen scope) at a note that does not exist.
 * `markNoteWritten` pins it the first time a note by that title is confirmed.
 */
export const noteTitle = (account: string): string => {
  const acct = getAccount(account);
  const named = acct?.note_list?.trim();
  if (named) return named;
  return acct ? `${householdTitle(acct)} list` : "Kitchen list";
};

/** One line per item, as a shopper would read it. */
export function lineText(l: {
  name: string;
  amount: string | null;
  reason: string;
  why: string;
}): string {
  const amount = l.amount ? `, ${l.amount}` : "";
  const why = l.reason === "meal" ? ` (${l.why})` : "";
  return `${l.name}${amount}${why}`;
}

/**
 * The note as it should read above the sentinel. The suggestion tray is left
 * out on purpose: it needs answers, and in a note it is only more to read past
 * in a shop.
 */
export function noteLines(account: string): NoteLine[] {
  const s = shopping(account);
  const out: NoteLine[] = [{ kind: "title", text: noteTitle(account) }];
  for (const g of s.groups) {
    out.push({ kind: "heading", text: g.title });
    for (const l of g.lines) out.push({ kind: "item", text: lineText(l) });
  }
  if (!s.groups.length) out.push({ kind: "text", text: "Nothing is out." });
  return out;
}

export function noteSignature(account: string): string {
  return createHash("sha256")
    .update(JSON.stringify(noteLines(account)))
    .digest("hex")
    .slice(0, 16);
}

/** The lines as Edmund is shown them in an event or a tool result. */
export function noteText(lines: NoteLine[]): string {
  return lines
    .map((l) =>
      l.kind === "title"
        ? `${l.text}   (title: the first line)`
        : l.kind === "heading"
          ? `${l.text}   (heading)`
          : l.kind === "item"
            ? `[ ] ${l.text}`
            : l.text,
    )
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * When
 * ------------------------------------------------------------------ */

export type NoteState = {
  /** Signature of the list the note was last brought up to date with. */
  written: string | null;
  writtenAt: string | null;
  /** The list's signature when last looked at, and since when it has held. */
  seen: string | null;
  seenSince: string | null;
  /** A signature already reported as not wakeable, so the log says it once. */
  held: string | null;
};

const EMPTY: NoteState = {
  written: null,
  writtenAt: null,
  seen: null,
  seenSince: null,
  held: null,
};

/** Asked for from the site: due now, without the settling wait. */
const REQUESTED = "requested";

export const notePath = (account: string): string => join(accountDir(), account, "note.json");

export function readNoteState(account: string): NoteState {
  const p = notePath(account);
  if (!existsSync(p)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<NoteState>) };
  } catch {
    return { ...EMPTY };
  }
}

function writeNoteState(account: string, patch: Partial<NoteState>): NoteState {
  const next = { ...readNoteState(account), ...patch };
  const p = notePath(account);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Whether Edmund should be woken to bring this household's note up to date:
 * the list differs from what the note was last brought to, and has not
 * changed for SETTLE_MS. A household seen for the first time counts as up to
 * date, because until now the note was kept current by the old browser sync.
 */
export function noteDue(account: string, now = Date.now()): { due: boolean; signature: string } {
  const signature = noteSignature(account);
  const st = readNoteState(account);
  if (st.written === null && st.seen === null) {
    writeNoteState(account, {
      written: signature,
      writtenAt: iso(now),
      seen: signature,
      seenSince: iso(now),
    });
    return { due: false, signature };
  }
  if (signature === st.written) return { due: false, signature };
  if (st.written === REQUESTED) return { due: true, signature };
  if (signature !== st.seen) {
    writeNoteState(account, { seen: signature, seenSince: iso(now) });
    return { due: false, signature };
  }
  const since = st.seenSince ? Date.parse(st.seenSince) : now;
  return { due: now - since >= SETTLE_MS, signature };
}

/** Edmund has brought the note up to date with the list as it stands. */
export function markNoteWritten(account: string, now = Date.now()): void {
  // The note now exists under this title, so it is its name from here on.
  if (getAccount(account) && !getAccount(account)?.note_list?.trim()) {
    updateAccount(account, { note_list: noteTitle(account) });
  }
  const signature = noteSignature(account);
  writeNoteState(account, {
    written: signature,
    writtenAt: iso(now),
    seen: signature,
    seenSince: iso(now),
    held: null,
  });
}

/** Somebody asked for the note to be brought up to date now. */
export function requestNoteUpdate(account: string): void {
  writeNoteState(account, { written: REQUESTED, held: null });
}

/** Whether the note is behind the list as far as the kitchen knows. */
export function noteBehind(account: string): boolean {
  const st = readNoteState(account);
  if (st.written === null && st.seen === null) return false; // not looked at yet: see noteDue
  return st.written !== noteSignature(account);
}

/** Record that this signature could not be woken for; true the first time. */
export function holdNote(account: string, signature: string): boolean {
  if (readNoteState(account).held === signature) return false;
  writeNoteState(account, { held: signature });
  return true;
}

/**
 * Whether a chat would be given Notes by the computer-use policy right now.
 * The same decision the screen server makes, so a household whose chat has
 * no screen tools (a contact's, while the safety check only shadows) is not
 * woken for an edit it cannot make.
 */
export function canEditNotes(config: Config | null, session: string): boolean {
  if (!config) return false;
  const policy = sessionPolicy(config, tierForSessionKey(config, session), session);
  return !!policy?.apps.some((a) => ["notes", "com.apple.notes"].includes(a.trim().toLowerCase()));
}
