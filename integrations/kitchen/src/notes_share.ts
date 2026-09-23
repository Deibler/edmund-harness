/**
 * Inviting household members to the shared note on icloud.com.
 *
 * No local automation can invite anyone to a note: AppleScript's `shared` is
 * read only, the Notes sharing extension does nothing, and the share sheet
 * exposes no accessibility children. Access is gated on the invite list, so a
 * link alone is not enough. The invite UI is only reachable as ordinary DOM on
 * icloud.com; `icloud.ts` opens the note and this decides who should be on it.
 *
 *   - Read before write: the participant list is read first and only the
 *     missing are invited, so sharing twice never invites twice.
 *   - Verify after: the result is read back off the page, never assumed from a
 *     successful click.
 */

import { type Failure, type Page, evaluate, pressEnter, sleep, typeText } from "./icloud.ts";

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

/* ------------------------------------------------------------------ *
 * Comparing people
 * ------------------------------------------------------------------ */

/**
 * Reduce a handle to a key two spellings of the same person share.
 *
 * iCloud renders "+15550100001" as "+1 (555) 010-0001", so a literal compare
 * re-invites on every run. Phone numbers collapse to their last ten digits
 * (country codes are inconsistent), emails to lowercase.
 */
export function idKey(handle: string): string {
  const s = handle.trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  // No digits means a display name, which is what iCloud shows once somebody
  // accepts. It keys as itself, so distinct names never compare equal.
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
 * Read who is on the note: one `.ck-sharing-manage-share-list-item-view` per
 * participant, the person followed by "(Owner)" or "Invited".
 *
 * `ok` is separate from an empty list because an unrendered popover and a note
 * nobody is on look the same, and mistaking one for the other would re-invite
 * the whole household.
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
 * Put everyone named on the already-open note, nobody twice. Runs inside the
 * sync's browser session so the note is opened once.
 */
export async function shareOpenNote(
  cdp: Page,
  recipients: string[],
  /**
   * Handles a previous run put on this note. Needed because a participant's
   * label turns into a contact name once they accept. Trusted only while the
   * note still has at least that many guests; if somebody was removed, matching
   * falls back to labels and they are re-invited.
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
  // Guests exclude the owner. Fewer guests than remembered means somebody was
  // removed, so the memory is not trusted.
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

  // Verify by reading the participant list back.
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
