/**
 * Keeping every household's note equal to its list, without being asked.
 *
 * The note is the surface people actually shop from — it is already on the
 * phone, already shared with the person pushing the trolley, already open
 * before anyone parks. A better list on a different URL loses to a worse list
 * in Notes every time. So the site stops competing and starts feeding.
 *
 * Three things decide the shape of this module.
 *
 * DRIVING A BROWSER IS EXPENSIVE. The watch pass runs every ten seconds and a
 * sync takes the better part of a minute, so the note is only touched when the
 * list has actually changed. `buildDoc` is pure and cheap, so the decision to
 * sync costs a fold over the ledger and no browser at all — the signature it
 * returns deliberately excludes the timestamp and the ticks, because rewriting
 * the note while somebody is standing in an aisle is the worst thing this can
 * do and neither of those means the list changed.
 *
 * TICKS ARE THEIRS. A ticked box is a person saying "in the cart". It is read
 * before every write and put back exactly where it was, and it is never
 * consumed: nothing here concludes from a tick that the food is now owned. That
 * is the receipt's job, and inventing stock from a tick would put a lie in the
 * ledger. The existing "finished shopping" flow is what clears them.
 *
 * INVITING IS NOT AUTOMATIC. Writing into a note in this account's own iCloud
 * has no outward effect and runs on its own. Sending somebody an invite does,
 * so a household's FIRST share is always an explicit act. Once one exists, new
 * members are kept in step automatically, which is the part that would
 * otherwise silently rot.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accountDir, baseDir, getAccount, listAccounts, updateAccount } from "./accounts.ts";
import { type Failure, openedUrl, readBody, withNote, writeBody } from "./icloud.ts";
import { addToList } from "./list.ts";
import {
  adoptable,
  buildDoc,
  noteTitle,
  parseAppleHtml,
  sameDoc,
  signatureOf,
  splitOwned,
  ticksIn,
  toAppleHtml,
  wanted,
} from "./notedoc.ts";
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
  /** Tick state as of the last read, so the site can show what is in the cart. */
  ticks: Record<string, boolean>;
  /** Participant labels as iCloud last rendered them. Display only. */
  participants: string[];
  /**
   * Handles this integration has successfully put on the note.
   *
   * Kept separately from `participants` because the two are not the same thing.
   * A participant's LABEL is whatever iCloud feels like showing — the handle
   * until they accept, their contact name afterwards — so it cannot be compared
   * to a phone number to decide whether somebody still needs inviting. This is
   * the stable side of that pair and it is what stops the sync re-inviting the
   * household every time the shopping list changes.
   */
  invitedHandles: string[];
  /**
   * `tickKey` of every line the last write generated.
   *
   * Without this there is no way to tell our own block's lines from one a
   * person typed into the middle of it, and the difference decides whether
   * that line is rewritten away or promoted onto the real list.
   */
  ourLines: string[];
  /** Last failure, kept so a silently broken sync is visible somewhere. */
  error: string | null;
  /** How the last write got there. Only one transport writes; see below. */
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
    // A corrupt state file costs one redundant sync, not the note.
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
 * Should this household's note be touched right now, and why.
 *
 * Pure and cheap by design — this is what the ten-second pass calls, and it
 * must not open a browser to find out that nothing happened.
 */
export function syncNeeded(
  account: string,
  force = false,
): { need: boolean; why: Why; signature: string } {
  const st = readState(account);
  // Built against an empty note on purpose. The signature covers the generated
  // block alone, so ticks and the household's own lines cannot influence it —
  // which is what lets this answer without opening a browser to look.
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
 * One sync at a time across every process.
 *
 * The watch pass, the daily pass and an MCP tool can all decide to sync at
 * once, and they would be driving the same browser tab into the same note. The
 * lock is a file with a timestamp rather than anything cleverer because the
 * failure it has to survive is a process being killed mid-sync, which no
 * in-memory guard can.
 *
 * It is taken INSIDE `syncNote`, and that is the whole point of this section.
 * All of the above was true and written down from the first version, which then
 * took the lock on exactly one of the three paths that reach a note; the other
 * two collided on a real evening. Two processes driving one tab do not fail
 * cleanly. They select-all over each other, take each other's clipboard, and
 * navigate the page out from under a script that is still running, which
 * surfaces as "the note could not be read back after writing" and as "Inspected
 * target navigated or closed" and leaves a note holding a merged copy of two
 * writes. A guard a caller has to remember to take is not a guard.
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
 * Is somebody mid-sync right now?
 *
 * Advisory, and only good for skipping work that is about to be done anyway.
 * Anything that actually opens the note takes the lock instead.
 */
export const syncRunning = (): boolean => lockedAt() !== null;

/** How long a caller with a person waiting on it queues behind a sync in flight. */
export const WAIT_MS = 60_000;

/**
 * Take the lock, optionally waiting for whoever holds it to finish.
 *
 * Waiting is for the paths a person is sitting in front of: a tool call that
 * lands while the background pass happens to be mid-sync should queue behind it
 * rather than report a failure for something that is about to be right anyway.
 * The background pass itself never waits, because it is re-run every ten
 * seconds and blocking would only stack copies of it behind each other.
 *
 * Created exclusively rather than checked and then written, so two processes
 * looking at the same instant cannot both decide the lock is free.
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
    // A lock nobody holds belonged to a process killed mid-sync. Clearing it is
    // the only way out of that, since no in-memory guard survives a kill.
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
 * Run something with the note to itself.
 *
 * The pair is deliberately not exported separately. Taking a lock and releasing
 * it are two things to remember and this feature has already been bitten once
 * by a guard somebody forgot to take; as one function there is nothing to
 * forget, and no path out of `fn` that leaves it held.
 *
 * Returns `null` when the wait ran out, which the caller reports rather than
 * throwing, because losing a race with the background pass is not an error.
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
   * below the sentinel, no adoption pass.
   *
   * A reset, not a sync, and the only path here that deliberately discards a
   * person's own lines — so it reports every one it dropped rather than doing it
   * quietly. Everything else in this file exists to make sure their lines
   * survive; this is the one case where somebody has asked for the opposite.
   */
  fresh?: boolean;
  /**
   * How long to queue behind a sync already in flight, in milliseconds.
   *
   * Zero, the default, is for anything on a timer: it will run again shortly
   * and blocking would only stack copies of it up. Anything with a person
   * waiting on it should pass `WAIT_MS`.
   */
  wait?: number;
};

/**
 * Bring one household's note up to date.
 *
 * Reads first, always. The note is a shared document that people edit, so the
 * only safe way to rewrite part of it is to know what the rest currently says —
 * their lines below the sentinel pass through untouched, and their ticks come
 * back exactly where they were.
 *
 * Nothing else in this file opens a note. Everything goes through here, and
 * here is where the lock is taken, so "two of these at once" is not a mistake
 * any caller is able to make.
 */
export async function syncNote(account: string, opts: SyncOpts = {}): Promise<SyncResult> {
  const acct = getAccount(account);
  const title = noteTitle(account);
  if (!acct) return { ok: false, account, title, error: `No household called "${account}".` };

  const out = await withNoteLock(opts.wait ?? 0, () => syncOpenNote(account, title, opts));
  // Not much of a failure, and the message says so. The list itself is already
  // recorded, and whoever holds the lock is either writing it now or about to
  // be followed by a pass that will.
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
      // Null is a FAILED read, not an empty note — an empty note comes back as an
      // empty string. Conflating them would rewrite a shared note from a body
      // that was never its body, which is how the household's own lines get
      // destroyed. Refusing costs one stale sync; the alternative costs a list.
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

      // Anything they wrote below the sentinel joins the real list before the
      // rest of this pass looks at it, so a line typed on a phone in a shop is a
      // list line like any other from here on: it renders in the block above,
      // costs money on the trip, and can be taken off from the site. Merging on
      // the key means re-reading the same line next pass changes nothing.
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

      // Measured over the same thing on both sides: the generated block, without
      // the sentinel, the timestamp or any ticks. A human mangling our block is a
      // change worth repairing; a human writing below the sentinel is not, and
      // somebody ticking the eggs certainly is not.
      const before = signatureOf(splitOwned(current, ourLines).ours);
      const doc = buildDoc(account, opts.fresh ? [] : current, undefined, ourLines);
      const changed = opts.fresh || before !== doc.signature || !current.length;

      let wrote = false;
      if (changed) {
        // The note has to come back saying what was sent, or this pass failed.
        // Reporting a write that did not replace anything is what let a note fill
        // up with copies of itself: the signature below would say the note was
        // current, and nothing would open it again to find out otherwise.
        const w = await writeBody(cdp, toAppleHtml(doc.blocks), (body) =>
          sameDoc(doc.blocks, parseAppleHtml(body)),
        );
        if (!w.ok) return { ok: false as const, error: `The note was not rewritten: ${w.why}.` };
        wrote = true;
      }

      // Sharing rides along in the same session rather than opening the note a
      // second time. Only ever with people the household actually contains.
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
          // Remembered by HANDLE, because the label will change to a contact name
          // the moment they accept and stop being comparable to anything.
          onNote = [...new Set([...st.invitedHandles, ...s.added, ...s.present])];
        } else {
          shareError = s.error;
        }
        // A share failure is deliberately not fatal. The list being current
        // matters more than the participant list being perfect, and the error is
        // recorded rather than thrown away.
      }

      return {
        ok: true as const,
        wrote,
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
    /**
     * Deliberately NOT falling back to AppleScript, which was the first design
     * and was wrong.
     *
     * The local Notes app is a REPLICA and it lags iCloud by minutes. Writing
     * through it while the browser owns the note means two replicas edited the
     * same document from different starting points, and iCloud resolves that by
     * keeping both — which is exactly what happened: the note came back holding
     * the list twice, once as checkboxes and once as dashes.
     *
     * So a failure here leaves the note alone and says so. A note that is a few
     * hours stale is a nuisance; a note holding two contradictory copies of the
     * list is worse than no note at all.
     */
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
 * Sync whichever households need it.
 *
 * Bounded to one household per call. A sync is close to a minute of browser
 * driving, and doing four back to back would hold the lock long past the point
 * where the next watch tick could do anything useful; the next pass picks up
 * the next household ten seconds later.
 */
export async function syncDueNotes(force = false): Promise<SyncResult[]> {
  const due = listAccounts()
    .map(({ id }) => ({ id, ...syncNeeded(id, force) }))
    .filter((a) => a.need);
  if (!due.length) return [];
  // A peek, not a claim. `syncNote` takes the real lock; this only keeps a poll
  // that fires every ten seconds from logging a failure for every second of a
  // sync that is running perfectly well.
  if (syncRunning()) return [];
  // Oldest first, so a household that has never synced is not starved by one
  // whose list changes constantly.
  const pick = due.sort((a, b) =>
    (readState(a.id).syncedAt ?? "").localeCompare(readState(b.id).syncedAt ?? ""),
  )[0];
  return pick ? [await syncNote(pick.id)] : [];
}

/** What the site should show as already in the cart. */
export function tickedNow(account: string): Set<string> {
  const st = readState(account);
  return new Set(
    Object.entries(st.ticks)
      .filter(([, v]) => v)
      .map(([k]) => k),
  );
}
