/**
 * The watch pass's note step: whether to wake the household's session to
 * bring its shared note up to date, and what to log when it does not.
 *
 * The note has no writer but Edmund on screen, so each thing that would make
 * that impossible is checked before a wake is spent on it:
 *   - the household has a session, and the screen policy gives it Notes;
 *   - the retry ledger would let a wake go out at all;
 *   - the Mac is not locked. A locked Mac (or a screen saver, which macOS 26
 *     runs over the lock shield) refuses every input, so a wake then is a
 *     model turn that can only fail and uses up one of the list's attempts.
 *     It is asked last because it means starting the screen helper.
 *
 * Nothing is dropped: a note that cannot be woken for stays due, and is woken
 * for on the first pass where it can be.
 */

import type { Config } from "../../../src/config/config.ts";
import type { JobInput } from "../../../src/cron/types.ts";
import { NativeHelper } from "../../../src/mcp/computer-use/native.ts";
import { canEditNotes, holdNote, noteDue, requestAnswered } from "./notelist.ts";
import type { Account } from "./types.ts";
import { MAX_ATTEMPTS, noteKey, sessionFor, wakeForNote, wakeHeld } from "./wake.ts";

export type NoteStepDeps = {
  /**
   * Whether the Mac's session is locked. Required, so a test cannot reach the
   * real screen helper by leaving it out; the watch pass passes `screenLocked`.
   */
  locked: () => Promise<boolean>;
  now?: number;
  /** The cron insert, for tests; defaults to the harness cron store. */
  create?: (input: JobInput) => { id: string };
};

/** One pass over one household's note. Returns the lines to log. */
export async function noteStep(
  account: string,
  acct: Account,
  config: Config | null,
  deps: NoteStepDeps,
): Promise<string[]> {
  const now = deps.now ?? Date.now();
  const { due, signature, requested } = noteDue(account, now);
  if (!due) return [];

  const session = sessionFor(acct);
  if (!session || !canEditNotes(config, session)) {
    if (!holdNote(account, signature)) return [];
    return [
      `note is behind the list, but ${session ? `${session} has no screen tools for Notes` : "the household has no session"}; not waking`,
    ];
  }

  const hold = wakeHeld(account, noteKey(signature), now, requested);
  if (hold === "recent") return [];
  if (hold === "exhausted") {
    if (!holdNote(account, signature)) return [];
    return [
      `note still behind after ${MAX_ATTEMPTS} wakes; waiting for the list to change or for somebody to ask from the site`,
    ];
  }

  let locked: boolean;
  try {
    locked = await deps.locked();
  } catch (e) {
    if (!holdNote(account, `unknown:${signature}`)) return [];
    return [
      `note is behind the list, but whether the Mac is locked could not be read (${(e as Error).message}); not waking until it can`,
    ];
  }
  if (locked) {
    if (!holdNote(account, `locked:${signature}`)) return [];
    return ["note is behind the list, but the Mac is locked; waking once it is unlocked"];
  }

  const w = wakeForNote(account, acct, signature, {
    now,
    fresh: requested,
    ...(deps.create ? { create: deps.create } : {}),
  });
  if (w.woke.length && requested) requestAnswered(account);
  return w.woke.map(
    (x) =>
      `note is behind the list${requested ? " (asked for from the site)" : ""}; woke ${x.session}, job ${x.job}`,
  );
}

/**
 * The computer-use server's own answer to "is the Mac locked": the screen
 * helper's `permissions` call, which is what makes the server refuse input
 * with "The Mac is locked". Started for one question and stopped again.
 */
export async function screenLocked(): Promise<boolean> {
  const helper = new NativeHelper();
  try {
    return (await helper.permissions()).locked;
  } finally {
    helper.close();
  }
}
