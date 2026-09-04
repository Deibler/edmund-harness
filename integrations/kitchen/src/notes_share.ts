/**
 * Inviting people to a note, which is the one thing local automation cannot do.
 *
 * Apple exposes no invite anywhere a script can reach: the dictionary's
 * `shared` property is read only, `NSSharingService` named
 * `com.apple.Notes.SharingExtension` does nothing for Notes, and the share
 * sheet is hosted by `ShareSheetUI`, which reports zero children to
 * accessibility, so there is not even a button to press. A link on its own is
 * worthless too, because access is gated on the invite list rather than on the
 * link, which is why "just send them the URL" is not an answer.
 *
 * The invite UI does exist in exactly one place a program can touch it:
 * icloud.com/notes, where it is ordinary DOM. `icloud.ts` gets a note open;
 * this decides who should be on it.
 *
 *   - READ BEFORE WRITE. Sharing twice must not invite twice, so this always
 *     reads the participant list first and adds only who is missing. Calling it
 *     on an already correct note does nothing at all and says so.
 *   - VERIFY AFTER. The result is read back off the page, never assumed from
 *     the fact that a click succeeded.
 */

import {
  type Failure,
  type Page,
  evaluate,
  openedUrl,
  pressEnter,
  sleep,
  typeText,
  withNote,
} from "./icloud.ts";

export type Participant = {
  /** As iCloud renders it: a name, an email, or a formatted phone number. */
  label: string;
  owner: boolean;
  /** True until the person opens the invite. */
  invited: boolean;
};

export type ShareOutcome = {
  ok: true;
  participants: Participant[];
  /** Recipients this call actually invited. Empty means it was already right. */
  added: string[];
  /** Recipients asked for that were already on. */
  present: string[];
  /** The share link, which is the thing you can actually send somebody. */
  link: string | null;
};

export type ShareResult = (ShareOutcome & { title: string; url: string | null }) | Failure;

/* ------------------------------------------------------------------ *
 * Comparing people
 * ------------------------------------------------------------------ */

/**
 * Reduce a handle to something two spellings of the same person share.
 *
 * The page renders what you typed as "+1 (555) 010-0001", so a literal
 * comparison against "+15550100001" says the person is missing and invites them
 * a second time on every run. Phone numbers collapse to their last ten digits
 * because country code presence is inconsistent between what a caller passes
 * and what iCloud displays; email collapses to lowercase.
 */
export function idKey(handle: string): string {
  const s = handle.trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  // A label with no digits in it is a DISPLAY NAME, not a broken number. Once
  // somebody accepts an invite iCloud stops showing their handle and shows
  // their contact name instead, so this is the normal steady state rather than
  // an edge case. Returning "" for those made every name equal to every other
  // name, which is a worse failure than not matching at all.
  if (!digits) return `name:${s.replace(/\s+/g, " ")}`;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Pull messageable handles out of household principals. */
export function handlesFor(principals: string[]): string[] {
  const out: string[] = [];
  for (const p of principals) {
    if (p.startsWith("imessage:group:")) continue;
    const tail = p.split(":").pop()?.trim();
    if (!tail) continue;
    if (tail.includes("@") || /^\+?\d{10,}$/.test(tail)) out.push(tail);
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ *
 * The page steps
 * ------------------------------------------------------------------ */

/** Open the share popover, whichever of its two shapes applies. */
const OPEN_SHARE = `
  const btn = await wait(() => byLabel(/add people to this note|view participants/i));
  if (!btn) return { ok: false, why: 'no share button' };
  btn.click();
  await new Promise((r) => setTimeout(r, 700));
  const already = !!(await wait(() => byLabel(/^Add People$/i), 1200));
  return { ok: true, alreadyShared: already };
`;

/**
 * Read who is on the note.
 *
 * Each participant is one `.ck-sharing-manage-share-list-item-view`, whose text
 * is the person followed by "(Owner)" or "Invited". An earlier version scanned
 * for any div containing "(Owner)" and took the last match, which is the most
 * deeply nested one — that returned a single row and reported the two people
 * actually on the note as absent.
 *
 * `ok` is separate from an empty list on purpose. A popover that has not
 * rendered yet and a note nobody is on look identical in the DOM, and treating
 * the first as the second would re-invite the whole household on every run.
 */
const READ_PEOPLE = `
  const rows = await wait(() => {
    const r = all('.ck-sharing-manage-share-list-item-view');
    return r.length ? r : null;
  }, 6000);
  if (!rows) return { ok: false, people: [] };
  const people = rows.map((r) => {
    const parts = (r.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
    const rest = parts.slice(1).join(' ');
    return {
      label: parts[0] || '',
      owner: /\\(Owner\\)/i.test(rest),
      invited: /Invited/i.test(rest),
    };
  }).filter((p) => p.label);
  return { ok: true, people };
`;

/** Get to the field that takes email addresses and phone numbers. */
const OPEN_ADD_FIELD = `
  const add = byLabel(/^Add People$/i);
  if (add) {
    add.click();
    await new Promise((r) => setTimeout(r, 700));
  }
  const linkTab = await wait(() => all('[role=tab]').find((t) => /Copy Link/i.test(t.innerText || '')), 4000);
  if (linkTab && linkTab.getAttribute('aria-selected') !== 'true') {
    linkTab.click();
    await new Promise((r) => setTimeout(r, 500));
  }
  const field = await wait(() => {
    const c = all('[contenteditable=true], input[type=text]')
      .filter((e) => e.offsetParent !== null);
    return c.length ? c[c.length - 1] : null;
  }, 6000);
  if (!field) return { ok: false, why: 'no recipient field' };
  const f = document.querySelector('iframe');
  if (f && f.contentWindow) f.contentWindow.focus();
  field.focus();
  return { ok: true };
`;

const SUBMIT = `
  const btn = await wait(() => {
    const b = byLabel(/^Share$/i);
    return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled ? b : null;
  }, 6000);
  if (!btn) return { ok: false, why: 'share button never enabled' };
  btn.click();
  await new Promise((r) => setTimeout(r, 2500));
  const text = doc().body.innerText || '';
  const m = text.match(/https:\\/\\/www\\.icloud\\.com\\/notes\\/[A-Za-z0-9_-]+/);
  const close = byLabel(/^Close$/i);
  if (close) close.click();
  return { ok: true, link: m ? m[0] : null };
`;

/* ------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------ */

/**
 * Put everyone named on the note that is already open, and nobody twice.
 *
 * Separate from `shareNote` so a sync that has just written the list can invite
 * in the same browser session rather than opening the note a second time.
 */
export async function shareOpenNote(
  cdp: Page,
  recipients: string[],
  /**
   * Handles a previous run already put on this note successfully.
   *
   * Needed because a participant's label is not stable: iCloud shows the handle
   * you invited until the person accepts, and their CONTACT NAME afterwards.
   * From that moment no comparison against a phone number can recognise them,
   * so without this the sync re-invites everyone who ever accepted, every time
   * the list changes. Trusted only while the note still holds at least as many
   * people as we believe we put there — if somebody has actually been removed,
   * this falls back to matching on labels and re-invites them.
   */
  alreadyOn: string[] = [],
): Promise<ShareOutcome | Failure> {
  const want = [...new Set(recipients.map((r) => r.trim()).filter(Boolean))];
  if (!want.length) return { ok: false, error: "No one to share with." };

  const opened = await evaluate<{ ok: boolean; alreadyShared?: boolean; why?: string }>(
    cdp,
    OPEN_SHARE,
  );
  if (!opened.ok) return { ok: false, error: `Could not open the share panel (${opened.why}).` };

  let existing: Participant[] = [];
  if (opened.alreadyShared) {
    const read = await evaluate<{ ok: boolean; people: Participant[] }>(cdp, READ_PEOPLE);
    if (!read.ok) {
      return {
        ok: false,
        error:
          "The note is shared but its participant list did not render, so there is no way " +
          "to tell who is already on it. Refusing rather than risk inviting everyone twice.",
      };
    }
    existing = read.people;
  }
  const have = new Set(existing.map((p) => idKey(p.label)));
  // One of the participants is us, the owner. Everyone else is somebody a run
  // like this one put there, so a shortfall means a person was removed and the
  // remembered list can no longer be believed.
  const guests = existing.filter((p) => !p.owner).length;
  const trustMemory = alreadyOn.length > 0 && guests >= alreadyOn.length;
  const remembered = new Set(trustMemory ? alreadyOn.map(idKey) : []);
  const on = (r: string) => have.has(idKey(r)) || remembered.has(idKey(r));

  const missing = want.filter((r) => !on(r));
  const present = want.filter((r) => on(r));

  if (!missing.length) {
    return { ok: true, participants: existing, added: [], present, link: null };
  }

  const field = await evaluate<{ ok: boolean; why?: string }>(cdp, OPEN_ADD_FIELD);
  if (!field.ok) return { ok: false, error: `Could not reach the recipient field (${field.why}).` };

  for (const r of missing) {
    await typeText(cdp, r);
    await pressEnter(cdp);
    await sleep(400);
  }

  const sent = await evaluate<{ ok: boolean; why?: string; link?: string | null }>(cdp, SUBMIT);
  if (!sent.ok) return { ok: false, error: `The invite was not sent (${sent.why}).` };

  // Read the truth back rather than trusting the click.
  await sleep(1200);
  const reopened = await evaluate<{ ok: boolean; alreadyShared?: boolean }>(cdp, OPEN_SHARE);
  const after =
    reopened.ok && reopened.alreadyShared
      ? (await evaluate<{ ok: boolean; people: Participant[] }>(cdp, READ_PEOPLE)).people
      : existing;
  const now = new Set(after.map((p) => idKey(p.label)));
  const stuck = missing.filter((r) => !now.has(idKey(r)));

  if (stuck.length) {
    return {
      ok: false,
      error: `iCloud accepted the invite but ${stuck.join(", ")} did not appear on the note. That usually means the address is not an Apple Account.`,
    };
  }
  return { ok: true, participants: after, added: missing, present, link: sent.link ?? null };
}

/** Who is currently on the note. Read only; invites nobody. */
export async function noteShareStatus(title: string, known?: string | null): Promise<ShareResult> {
  return (await withNote(
    title,
    async (cdp): Promise<ShareResult> => {
      const opened = await evaluate<{ ok: boolean; alreadyShared?: boolean; why?: string }>(
        cdp,
        OPEN_SHARE,
      );
      if (!opened.ok)
        return { ok: false, error: `Could not open the share panel (${opened.why}).` };
      if (!opened.alreadyShared) {
        return {
          ok: true,
          title,
          participants: [],
          added: [],
          present: [],
          link: null,
          url: openedUrl(),
        };
      }
      const read = await evaluate<{ ok: boolean; people: Participant[] }>(cdp, READ_PEOPLE);
      if (!read.ok) return { ok: false, error: "The participant list did not render." };
      return {
        ok: true,
        title,
        participants: read.people,
        added: [],
        present: [],
        link: null,
        url: openedUrl(),
      };
    },
    { known },
  )) as ShareResult;
}

/**
 * Make sure everyone named is on the note, opening it first.
 *
 * Returns what it actually did rather than what it attempted. An empty `added`
 * with a populated `participants` is the steady state and the normal result of
 * running this on a schedule.
 */
export async function shareNote(
  title: string,
  recipients: string[],
  known?: string | null,
): Promise<ShareResult> {
  return (await withNote(
    title,
    async (cdp): Promise<ShareResult> => {
      const out = await shareOpenNote(cdp, recipients);
      if (!out.ok) return out;
      return { ...out, title, url: openedUrl() };
    },
    { known },
  )) as ShareResult;
}
