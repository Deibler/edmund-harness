/**
 * Keeping each household's shared Apple Note equal to its shopping list.
 *
 * The note is where people actually shop from, so the site feeds it rather
 * than competing with it.
 *
 *   - Touch the browser only when the list changed. The watch pass runs every
 *     ten seconds and a sync takes most of a minute, so the decision is a pure
 *     fold (`syncNeeded`) over a signature that excludes the timestamp and the
 *     ticks.
 *   - Ticks belong to the household. They are read before every write and put
 *     back where they were, and a tick never adds stock: a tick means "in the
 *     cart", and only a receipt says what was bought.
 *   - Inviting is explicit the first time. Writing into this account's own note
 *     has no outward effect; an invite does. Once a household has been shared
 *     with, new members are kept in step automatically.
 *   - One sync at a time, and only through `syncNote`, which takes the lock.
 *   - Only the web transport writes. The local Notes app is a lagging replica,
 *     and writing through both left notes holding the list twice.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountDir, baseDir, getAccount, listAccounts, updateAccount } from "./accounts.ts";
import { type Failure, openedUrl, readBody, withNote } from "./icloud.ts";
import { addToList } from "./list.ts";
import {
  adoptable,
  buildDoc,
  noteTitle,
  parseAppleHtml,
  signatureOf,
  splitOwned,
  ticksIn,
  wanted,
} from "./notedoc.ts";
import { writeNote } from "./notepatch.ts";
import { handlesFor, shareOpenNote } from "./notes_share.ts";

/** How long a note may go untouched before it is re-read to repair drift. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

/** A sync in flight is assumed dead after this, so a crash cannot wedge it. */
const LOCK_MS = 4 * 60 * 1000;

export type NotesState = {
  version: 1;
  /** `signatureOf` the last doc successfully written. */
  signature: string | null;
  syncedAt: string | null;
  /** Tick state as of the last read. Informational; nothing derives stock from it. */
  ticks: Record<string, boolean>;
  /** Participant labels as iCloud last rendered them. Display only. */
  participants: string[];
  /**
   * Handles this integration has put on the note. A participant's label changes
   * from the handle to a contact name once they accept, so only this list can
   * tell whether somebody still needs inviting.
   */
  invitedHandles: string[];
  /**
   * `tickKey` of every line the last write generated, so a line a person typed
   * into our block is adopted rather than rewritten away.
   */
  ourLines: string[];
  /** Last failure, kept so a silently broken sync is visible somewhere. */
  error: string | null;
  /** How the last write got there. Only the web transport writes. */
  via: "web" | null;
};

const EMPTY: NotesState = {
  version: 1,
  signature: null,
  syncedAt: null,
  ticks: {},
  participants: [],
  invitedHandles: [],
  ourLines: [],
  error: null,
  via: null,
};

export const statePath = (account: string): string => join(accountDir(), account, "notes.json");

export function readState(account: string): NotesState {
  const p = statePath(account);
  if (!existsSync(p)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<NotesState>) };
  } catch {
    // A corrupt state file costs one redundant sync.
    return { ...EMPTY };
  }
}

export function writeState(account: string, patch: Partial<NotesState>): NotesState {
  const next = { ...readState(account), ...patch };
  const p = statePath(account);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

/* ------------------------------------------------------------------ *
 * Deciding whether to bother
 * ------------------------------------------------------------------ */

export type Why = "changed" | "never" | "stale" | "forced" | null;

/**
 * Whether this household's note needs a sync now, and why. Pure and cheap: the
 * ten-second pass calls it, so it must not open a browser.
 */
export function syncNeeded(
  account: string,
  force = false,
): { need: boolean; why: Why; signature: string } {
  const st = readState(account);
  // Built against an empty note: the signature covers only the generated block,
  // so the note's current contents cannot change it.
  const { signature } = buildDoc(account, []);

  if (force) return { need: true, why: "forced", signature };
  if (!st.signature || !st.syncedAt) return { need: true, why: "never", signature };
  if (st.signature !== signature) return { need: true, why: "changed", signature };
  if (Date.now() - new Date(st.syncedAt).getTime() > REFRESH_MS) {
    return { need: true, why: "stale", signature };
  }
  return { need: false, why: null, signature };
}

/* ------------------------------------------------------------------ *
 * One at a time, everywhere
 * ------------------------------------------------------------------ */

const lockPath = () => join(baseDir(), "notes.lock");

/**
 * The cross-process note lock: a file holding a timestamp and pid.
 *
 * The watch pass, the daily pass and MCP tools all drive the same browser tab,
 * and two of them at once select-all over each other and leave a merged note.
 * A file survives a process killed mid-sync, which an in-memory guard cannot.
 * The lock is taken inside `syncNote`, so no caller can forget it; a lock older
 * than `LOCK_MS` is treated as abandoned.
 */
function lockedAt(): number | null {
  try {
    if (!existsSync(lockPath())) return null;
    const at = Number(readFileSync(lockPath(), "utf8").split("|")[0]);
    return Number.isFinite(at) && Date.now() - at < LOCK_MS ? at : null;
  } catch {
    return null;
  }
}

/**
 * Whether a sync is in flight. Advisory only, for skipping work; anything that
 * opens the note takes the lock.
 */
export const syncRunning = (): boolean => lockedAt() !== null;

/** How long a caller with a person waiting on it queues behind a sync in flight. */
export const WAIT_MS = 60_000;

/**
 * Take the lock, waiting up to `waitMs` for the holder to finish.
 *
 * Callers with a person waiting queue; the background pass passes zero, since
 * it reruns every ten seconds. The file is created exclusively (`wx`), so two
 * processes cannot both claim it.
 */
async function takeLock(waitMs = 0): Promise<boolean> {
  const p = lockPath();
  const until = Date.now() + waitMs;
  const claim = (): boolean => {
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${Date.now()}|${process.pid}`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  for (;;) {
    if (claim()) return true;
    // An expired lock belonged to a process killed mid-sync; clear it.
    if (lockedAt() === null) {
      try {
        unlinkSync(p);
      } catch {
        /* somebody else got there first */
      }
      if (claim()) return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function dropLock(): void {
  try {
    unlinkSync(lockPath());
  } catch {
    /* nothing to do about it */
  }
}

/**
 * Run `fn` holding the note lock, released on every path out. Take and release
 * are deliberately not exported separately. Returns `null` when the wait ran
 * out, which callers report rather than treat as an error.
 */
export async function withNoteLock<T>(waitMs: number, fn: () => Promise<T>): Promise<T | null> {
  if (!(await takeLock(waitMs))) return null;
  try {
    return await fn();
  } finally {
    dropLock();
  }
}

/* ------------------------------------------------------------------ *
 * One household
 * ------------------------------------------------------------------ */

export type SyncResult =
  | {
      ok: true;
      account: string;
      title: string;
      /** False when the note was already correct and nothing was written. */
      wrote: boolean;
      /** How a write went in: how many lines changed, or why the whole note was rewritten. */
      how: string | null;
      /** Lines somebody typed into the note that are now on the real list. */
      adopted: string[];
      /** Lines of theirs a `fresh` wipe discarded, so it can be said out loud. */
      dropped: string[];
      lines: number;
      ticked: string[];
      invited: string[];
      via: "web";
      url: string | null;
      link: string | null;
    }
  | (Failure & { account: string; title: string });

export type SyncOpts = {
  share?: boolean;
  shareWith?: string[];
  create?: boolean;
  /**
   * Rebuild the note from the ledger alone: no carried ticks, nothing kept from
   * below the sentinel, no adoption. The only path that discards a person's own
   * lines, so it reports every one it dropped.
   */
  fresh?: boolean;
  /**
   * How long to queue behind a sync in flight, in milliseconds. Zero for timers;
   * `WAIT_MS` when a person is waiting.
   */
  wait?: number;
};

/**
 * Bring one household's note up to date: read it, adopt lines typed below the
 * sentinel, write only if the generated block changed, then keep sharing in
 * step. The only entry point that opens a note, and where the lock is taken.
 */
export async function syncNote(account: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const acct = getAccount(account);
  const title = noteTitle(account);
  if (!acct) return { ok: false, account, title, error: `No household called "${account}".` };

  const out = await withNoteLock(opts.wait ?? 0, () => syncOpenNote(account, title, opts));
  // Losing the race is not really a failure: the list is saved, and the holder
  // or the next pass will write it.
  return (
    out ?? {
      ok: false,
      account,
      title,
      error:
        "another sync of this note is already running, so this one stood aside. " +
        "The list is saved and the next pass will put it on the note.",
    }
  );
}

async function syncOpenNote(account: string, title: string, opts: SyncOpts): Promise<SyncResult> {
  const acct = getAccount(account)!;
  const st = readState(account);
  const known = acct.note_url ?? acct.note_link ?? null;

  const out = await withNote(
    title,
    async (cdp) => {
      // Null is a failed read, not an empty note (that is ""). Writing from a body
      // that was never the note's would destroy the household's own lines.
      const html = await readBody(cdp);
      if (html === null) {
        return {
          ok: false as const,
          error: "Could not read the note body, so nothing was rewritten.",
        };
      }
      const current = parseAppleHtml(html);
      const ticks = ticksIn(current);
      const ourLines = new Set(st.ourLines);

      // Lines typed below the sentinel join the real list before the note is
      // rebuilt. The list merges on the key, so re-reading a line changes nothing.
      const theirs = splitOwned(current, ourLines).theirs;
      const dropped = opts.fresh ? theirs.filter(wanted).map((b) => b.text) : [];
      const adopted = opts.fresh ? [] : adoptable(theirs);
      if (adopted.length) {
        addToList(
          account,
          adopted.map((a) => ({
            name: a.name,
            amount: a.amount,
            why: "you added this in the note",
          })),
        );
      }

      // Compare the generated block as read against as built, over the same blocks.
      // Edits to our block get repaired; ticks and their own lines do not count.
      const before = signatureOf(splitOwned(current, ourLines).ours);
      const doc = buildDoc(account, opts.fresh ? [] : current, undefined, ourLines);
      const changed = opts.fresh || before !== doc.signature || !current.length;

      let wrote = false;
      let how: string | null = null;
      if (changed) {
        // A write that cannot be verified fails the pass, so the note is not
        // recorded as current and the next pass opens it again.
        const w = await writeNote(cdp, doc.blocks, current.length > 0);
        if (!w.ok) return { ok: false as const, error: `The note was not rewritten: ${w.why}.` };
        wrote = true;
        how = w.how;
      }

      // Sharing reuses this session. Only household members, plus anyone the
      // caller names explicitly.
      let invited: string[] = [];
      let link: string | null = null;
      let participants = st.participants;
      let onNote = st.invitedHandles;
      let shareError: string | null = null;
      const wants = [...new Set([...handlesFor(acct.members ?? []), ...(opts.shareWith ?? [])])];
      const firstTime = !acct.note_link && !st.invitedHandles.length;
      if (wants.length && (opts.share || !firstTime)) {
        const s = await shareOpenNote(cdp, wants, st.invitedHandles);
        if (s.ok) {
          invited = s.added;
          link = s.link;
          participants = s.participants.map((p) => p.label);
          // Remembered by handle: the label becomes a contact name once they accept.
          onNote = [...new Set([...st.invitedHandles, ...s.added, ...s.present])];
        } else {
          shareError = s.error;
        }
        // Not fatal: a current list matters more than the participant list. The
        // error is recorded in the state file.
      }

      return {
        ok: true as const,
        wrote,
        how,
        adopted: adopted.map((a) => a.text),
        dropped,
        lines: doc.lines,
        signature: doc.signature,
        ourTexts: doc.ourTexts,
        ticks: Object.fromEntries(ticks),
        ticked: [...ticks].filter(([, v]) => v).map(([k]) => k),
        invited,
        link,
        participants,
        onNote,
        shareError,
      };
    },
    { known, create: opts.create ?? true },
  );

  if (!out.ok) {
    // No AppleScript fallback. The local Notes app is a lagging replica; writing
    // through it while the browser owns the note makes iCloud keep both copies.
    // A stale note is better than one holding the list twice.
    writeState(account, { error: out.error });
    return { ...out, account, title };
  }

  const url = openedUrl();
  const learned: Record<string, string> = {};
  if (url) learned.note_url = url;
  if (out.link) learned.note_link = out.link;
  if (Object.keys(learned).length) updateAccount(account, learned);

  writeState(account, {
    signature: out.signature,
    syncedAt: new Date().toISOString(),
    ticks: out.ticks,
    ourLines: out.ourTexts,
    participants: out.participants,
    invitedHandles: out.onNote,
    error: out.shareError,
    via: "web",
  });

  return {
    ok: true,
    account,
    title,
    wrote: out.wrote,
    how: out.how,
    adopted: out.adopted,
    dropped: out.dropped,
    lines: out.lines,
    ticked: out.ticked,
    invited: out.invited,
    via: "web",
    url,
    link: out.link ?? getAccount(account)?.note_link ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Every household
 * ------------------------------------------------------------------ */

/**
 * Sync the household that most needs it, at most one per call, since each
 * sync is most of a minute of browser time. The next pass takes the next one.
 */
export async function syncDueNotes(force = false): Promise<SyncResult[]> {
  const due = listAccounts()
    .map(({ id }) => ({ id, ...syncNeeded(id, force) }))
    .filter((a) => a.need);
  if (!due.length) return [];
  // A peek, not a claim: keeps the ten-second poll from logging a failure while
  // a sync is running. `syncNote` takes the real lock.
  if (syncRunning()) return [];
  // Least recently synced first, so no household is starved.
  const pick = due.sort((a, b) =>
    (readState(a.id).syncedAt ?? "").localeCompare(readState(b.id).syncedAt ?? ""),
  )[0];
  return pick ? [await syncNote(pick.id)] : [];
}
