import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { Glob } from "bun";
import { normalizeHandle } from "./key.ts";

/**
 * Read-only index of the macOS Contacts.app AddressBook. Maps normalized
 * handles (phone / email / Apple ID) to the display name on the contact card.
 *
 * Used by ContactBook as a fallback: if the user hasn't listed a contact in
 * [[contacts]] (we only require that for multi-handle dedup), we still want
 * to display "Riley" in group rosters, not "+15550100004".
 *
 * Loaded once at startup. Graceful no-op if the DB isn't accessible.
 */
/** One address-book card: a person's name and the handles to reach them. */
export type ContactCard = { name: string; handles: string[] };

export class AddressBook {
  private handleToName = new Map<string, string>();
  private cards: ContactCard[] = [];

  constructor(dbPath?: string) {
    const path = dbPath ?? findAddressBookPath();
    if (!path) return;
    try {
      this.load(path);
    } catch (err) {
      console.warn("[address-book] failed to load:", (err as Error).message);
    }
  }

  lookup(handle: string): string | null {
    const n = normalizeHandle(handle);
    return this.handleToName.get(n) ?? null;
  }

  size(): number {
    return this.handleToName.size;
  }

  /**
   * Every distinct name on a contact card.
   *
   * Needed by the privacy scanner, which has to know what a name LOOKS like
   * to notice one leaving a conversation. Without this the scanner could only
   * see contacts declared in config.toml — one, in this deployment — so its
   * contact-name check was very nearly a no-op while reporting clean.
   */
  /**
   * Cards whose full name, or first name, is `name` (case-insensitive). Every
   * match is returned: two people called Chris are two answers, never one.
   */
  cardsNamed(name: string): ContactCard[] {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return [];
    return this.cards.filter((card) => {
      const full = card.name.toLowerCase();
      return full === wanted || full.split(/\s+/)[0] === wanted;
    });
  }

  allNames(): string[] {
    return [...new Set(this.handleToName.values())];
  }

  private load(path: string): void {
    const db = new Database(path, { readonly: true });
    try {
      const rows = db
        .query(
          `SELECT
             TRIM(COALESCE(r.ZFIRSTNAME, '') || ' ' || COALESCE(r.ZLASTNAME, '')) AS name,
             (SELECT GROUP_CONCAT(ZFULLNUMBER, '|') FROM ZABCDPHONENUMBER WHERE ZOWNER = r.Z_PK) AS phones,
             (SELECT GROUP_CONCAT(ZADDRESSNORMALIZED, '|') FROM ZABCDEMAILADDRESS WHERE ZOWNER = r.Z_PK) AS emails
           FROM ZABCDRECORD r
           WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL`,
        )
        .all() as Array<{ name: string | null; phones: string | null; emails: string | null }>;

      for (const r of rows) {
        const name = (r.name ?? "").trim();
        if (!name) continue;
        const card: ContactCard = { name, handles: [] };
        for (const ph of (r.phones ?? "").split("|").filter(Boolean)) {
          const variants = phoneVariants(ph);
          for (const variant of variants) {
            if (!this.handleToName.has(variant)) this.handleToName.set(variant, name);
          }
          // Dial in E.164 when the card's number can be written that way.
          card.handles.push(variants.find((v) => v.startsWith("+")) ?? variants[0]!);
        }
        for (const em of (r.emails ?? "").split("|").filter(Boolean)) {
          const key = em.toLowerCase().trim();
          if (key && !this.handleToName.has(key)) this.handleToName.set(key, name);
          if (key) card.handles.push(key);
        }
        if (card.handles.length > 0) this.cards.push(card);
      }
    } finally {
      db.close();
    }
  }
}

function findAddressBookPath(): string | null {
  const pattern = `${homedir()}/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb`;
  try {
    const glob = new Glob(pattern);
    for (const p of glob.scanSync({ absolute: true })) return p;
  } catch {
    // No Contacts at all: a fresh account, a machine that never opened the
    // app, a CI runner. The class above promises a graceful no-op when the
    // database is not accessible, and that promise has to cover finding it
    // as well as reading it.
  }
  return null;
}

/**
 * Contacts.app stores phones in many human formats: "+1 (555) 010-0001",
 * "555-010-0001", "5550100001". iMessage writes handles as E.164
 * ("+15550100001"). We normalize to strip formatting, then emit a few
 * variants so lookups succeed regardless of how the number was stored.
 */
function phoneVariants(raw: string): string[] {
  const stripped = normalizeHandle(raw);
  const out = new Set<string>([stripped]);
  if (/^\d{10}$/.test(stripped)) out.add(`+1${stripped}`);
  if (/^\+1\d{10}$/.test(stripped)) out.add(stripped.slice(2));
  if (/^\d{11}$/.test(stripped) && stripped.startsWith("1")) {
    out.add(`+${stripped}`);
    out.add(stripped.slice(1));
  }
  return [...out];
}
