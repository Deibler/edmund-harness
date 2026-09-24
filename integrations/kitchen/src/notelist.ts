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
 *   - `showNote` is what Edmund is shown each time he is asked to do it: the
 *     lines, the version they are, and which of his own earlier lines have
 *     left the list.
 *   - `markNoteWritten` is Edmund saying he has done it
 *     (`kitchen_shopping noteWritten:true noteVersion:<v>`), which records the
 *     version he was shown and its lines, and is what stops the next wake.
 *   - `canEditNotes` asks the computer-use policy whether a chat would get
 *     Notes at all, so no turn is spent waking a chat that cannot do the edit.
 *
 * The signature covers the list's lines only. Ticks and timestamps are not
 * the list changing, and waking a session to rework a note somebody is
 * shopping from is the worst thing this could do.
 *
 * Which lines above the sentinel are Edmund's is decided by what he wrote,
 * recorded when he confirms, never by where a line sits: people add to a list
 * between its lines and reword the lines already there. Only a recorded line
 * that has left the list may be deleted; any other line is the household's.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../../../src/config/config.ts";
import type { InstalledApp } from "../../../src/mcp/computer-use/native.ts";
import { approved, sessionPolicy } from "../../../src/mcp/computer-use/policy.ts";
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

/** A list's version: the hash of its lines, so the same list is the same version. */
function signatureOf(lines: NoteLine[]): string {
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex").slice(0, 16);
}

export function noteSignature(account: string): string {
  return signatureOf(noteLines(account));
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
 * Whose lines
 * ------------------------------------------------------------------ */

/**
 * How the event and the tool introduce Edmund's own earlier lines that have
 * left the list. The screen check (`destructive` in computer-use/guard.ts)
 * lets a scheduled turn delete a line only when its event lists it under
 * these words, so the two must say the same thing; a test pins them together.
 */
export const OWN_LINES = "Your own lines from the last time you wrote this note, now off the list";

/** The lines Edmund writes below the title: headings, items, "Nothing is out." */
const ownText = (lines: NoteLine[]): string[] =>
  lines.filter((l) => l.kind !== "title").map((l) => l.text);

/** Lines compared the way a person reads them: case and outer spaces aside. */
const fold = (s: string) => s.trim().toLowerCase();

/**
 * The lines the old browser sync last wrote (`notes.json` `ourLines`, folded
 * to lower case), for a household whose note has no record of its own yet.
 * Empty meant "no record" there too, so it is none here.
 */
function legacyLines(account: string): string[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(accountDir(), account, "notes.json"), "utf8")) as {
      ourLines?: unknown;
    };
    const ours = Array.isArray(raw.ourLines)
      ? raw.ourLines.filter((x): x is string => typeof x === "string" && !!x.trim())
      : [];
    return ours.length ? ours : null;
  } catch {
    return null;
  }
}

/** Both records, once each; null when there is neither. */
function union(...sets: Array<string[] | null>): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    for (const t of set ?? []) {
      if (seen.has(fold(t))) continue;
      seen.add(fold(t));
      out.push(t);
    }
  }
  return out.length ? out : null;
}

/** What Edmund is shown when he is asked to bring the note up to date. */
export type NoteBrief = {
  /** The list's version, which `noteWritten` hands back as `noteVersion`. */
  version: string;
  lines: NoteLine[];
  /**
   * Edmund's own recorded lines that are no longer on the list: the only
   * lines above the sentinel he may delete. Null when nothing records which
   * lines are his, so he may delete none.
   */
  gone: string[] | null;
};

/** Versions kept for a confirmation that arrives after the list moved on. */
const SHOWN_MAX = 10;

/**
 * The note as Edmund should make it read, and which of his lines have left
 * the list. Remembers the version, so a `noteWritten` naming it records these
 * lines even if the list has changed since.
 */
export function showNote(account: string, now = Date.now()): NoteBrief {
  const lines = noteLines(account);
  const version = signatureOf(lines);
  const st = readNoteState(account);
  const own = st.lines ?? legacyLines(account);
  const listed = new Set(ownText(lines).map(fold));
  const gone = own
    ? [...new Set(own.filter((t) => !listed.has(fold(t))).map((t) => t.trim()))]
    : null;
  const shown = [
    ...st.shown.filter((v) => v.version !== version),
    { version, lines: ownText(lines), at: iso(now) },
  ].slice(-SHOWN_MAX);
  writeNoteState(account, { shown });
  return { version, lines, gone };
}

/** The part of the event or tool reply that says whose lines may go. */
export function ownLinesText(gone: string[] | null): string {
  if (gone === null) {
    return "Nothing records which lines above the sentinel you wrote before, so delete none of them: leave every line up there that is not in the list where it is.";
  }
  if (!gone.length) {
    return "None of your own lines from the last time you wrote this note has left the list, so delete nothing above the sentinel.";
  }
  return [
    `${OWN_LINES}. These are the only lines above the sentinel you may delete:`,
    ...gone.map((t) => `  ${t}`),
  ].join("\n");
}

/** A line above the sentinel that is neither the list's nor a named one of Edmund's. */
export const THEIRS_ABOVE =
  "Above the sentinel, any other line not in the list is the household's, even one between your lines or one of yours they reworded. Never delete it: put it on the list with kitchen_shopping add, name exactly as written (by: whoever wrote it, when you can tell), and leave it where it is; it stands for that line, so do not write it again.";

/** The brief as a tool reply prints it: whose lines may go, then the lines. */
export function briefText(brief: NoteBrief): string {
  return [
    ownLinesText(brief.gone),
    brief.gone === null
      ? "Above the sentinel, leave every line that is not in the list where it is."
      : THEIRS_ABOVE,
    `Above the sentinel line it should read (version ${brief.version}):`,
    noteText(brief.lines),
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * When
 * ------------------------------------------------------------------ */

export type NoteState = {
  /** The version (signature) of the list the note was last brought up to date with. */
  written: string | null;
  writtenAt: string | null;
  /**
   * The lines below the title Edmund wrote at `written`, exactly as he was
   * shown them. Null until something records them.
   */
  lines: string[] | null;
  /** The list's signature when last looked at, and since when it has held. */
  seen: string | null;
  seenSince: string | null;
  /** A signature already reported as not wakeable, so the log says it once. */
  held: string | null;
  /**
   * When somebody asked from the site for the note to be brought up to date.
   * Makes the note due at once, and is cleared once a wake is queued for it.
   */
  requested: string | null;
  /** The versions Edmund was last shown, oldest first, with their lines. */
  shown: Array<{ version: string; lines: string[]; at: string }>;
};

const EMPTY: NoteState = {
  written: null,
  writtenAt: null,
  lines: null,
  seen: null,
  seenSince: null,
  held: null,
  requested: null,
  shown: [],
};

/** How a site request used to be stored, in place of a signature. */
const LEGACY_REQUESTED = "requested";

export const notePath = (account: string): string => join(accountDir(), account, "note.json");

export function readNoteState(account: string): NoteState {
  const p = notePath(account);
  if (!existsSync(p)) return { ...EMPTY };
  let st: NoteState;
  try {
    st = { ...EMPTY, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<NoteState>) };
  } catch {
    return { ...EMPTY };
  }
  if (!Array.isArray(st.shown)) st.shown = [];
  if (st.lines !== null && !Array.isArray(st.lines)) st.lines = null;
  if (st.written === LEGACY_REQUESTED) {
    st.requested = st.requested ?? st.writtenAt ?? new Date(0).toISOString();
    st.written = null;
  }
  return st;
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
 * somebody asked from the site, or the list differs from what the note was
 * last brought to and has not changed for SETTLE_MS. A household seen for the
 * first time counts as up to date, because until now the note was kept
 * current by the old browser sync.
 *
 * While the note is believed current and nothing records whose lines are
 * whose, the current lines (and whatever the old sync recorded) become the
 * record: they are what the kitchen last put there.
 */
export function noteDue(
  account: string,
  now = Date.now(),
): { due: boolean; signature: string; requested: boolean } {
  const lines = noteLines(account);
  const signature = signatureOf(lines);
  const st = readNoteState(account);
  const requested = st.requested !== null;
  if (st.written === null && st.seen === null && !requested) {
    writeNoteState(account, {
      written: signature,
      writtenAt: iso(now),
      lines: union(ownText(lines), legacyLines(account)),
      seen: signature,
      seenSince: iso(now),
    });
    return { due: false, signature, requested };
  }
  if (st.lines === null && signature === st.written) {
    writeNoteState(account, { lines: union(ownText(lines), legacyLines(account)) });
  }
  if (signature !== st.seen) writeNoteState(account, { seen: signature, seenSince: iso(now) });
  // A person asking is due now, whatever the list and the wait.
  if (requested) return { due: true, signature, requested };
  if (signature === st.written || signature !== st.seen)
    return { due: false, signature, requested };
  const since = st.seenSince ? Date.parse(st.seenSince) : now;
  return { due: now - since >= SETTLE_MS, signature, requested };
}

export type Written = { ok: true; version: string; current: boolean } | { ok: false; why: string };

/**
 * Edmund has brought the note up to date with the version he was shown.
 * Records that version and its lines as his; when the list has moved on
 * since, the note stays behind and the next wake brings the rest. A version
 * he was never shown records nothing.
 */
export function markNoteWritten(account: string, version: string, now = Date.now()): Written {
  const lines = noteLines(account);
  const signature = signatureOf(lines);
  const st = readNoteState(account);
  const current = version === signature;
  const own = current ? ownText(lines) : st.shown.find((v) => v.version === version)?.lines;
  if (!own) {
    return {
      ok: false,
      why: `version ${JSON.stringify(version)} is not one you were shown for this note`,
    };
  }
  // The note now exists under this title, so it is its name from here on.
  if (getAccount(account) && !getAccount(account)?.note_list?.trim()) {
    updateAccount(account, { note_list: noteTitle(account) });
  }
  writeNoteState(account, {
    written: version,
    writtenAt: iso(now),
    lines: own,
    held: null,
    ...(current
      ? { seen: signature, seenSince: iso(now), requested: null }
      : st.seen === signature
        ? {}
        : { seen: signature, seenSince: iso(now) }),
  });
  return { ok: true, version, current };
}

/** Somebody asked for the note to be brought up to date now. */
export function requestNoteUpdate(account: string, now = Date.now()): void {
  writeNoteState(account, { requested: iso(now), held: null });
}

/** A wake went out for the request, so later changes settle as usual. */
export function requestAnswered(account: string): void {
  if (readNoteState(account).requested !== null) writeNoteState(account, { requested: null });
}

/** Whether the note is behind the list as far as the kitchen knows. */
export function noteBehind(account: string): boolean {
  const st = readNoteState(account);
  if (st.requested !== null) return true;
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
  // The server's own matching, so "Notes.app" or a bundle id grants here too.
  return !!policy && approved(policy.apps, NOTES_APP);
}

/** Notes as the screen helper lists it among the installed apps. */
const NOTES_APP: InstalledApp = {
  bundleId: "com.apple.Notes",
  name: "Notes",
  displayName: "Notes",
  path: "/System/Applications/Notes.app",
};
