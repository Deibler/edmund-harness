import type { Contact } from "../config/config.ts";
import type { AddressBook, ContactCard } from "./address-book.ts";
import { normalizeHandle } from "./key.ts";

/** Where `label` finds a name Edmund was told (see learned-names.ts). */
export type LearnedNameSource = { get(handle: string): string | null };

/**
 * Handle → canonical handle + display name resolver.
 *
 * Two sources, in priority order:
 *  1. Explicit `[[contacts]]` entries in config.toml — required for multi-
 *     handle dedup (phone + email belonging to one person share a session).
 *  2. macOS Contacts.app AddressBook — fallback for display names only
 *     (the 99% case: one handle, one name, no dedup needed).
 */
export class ContactBook {
  private handleToCanon = new Map<string, string>();
  private canonToName = new Map<string, string>();
  /** Reverse index of `handleToCanon` built once at construction. Lets
   *  `aliasesFor` be O(1) per call instead of O(N) over every handle. */
  private canonToAliases = new Map<string, string[]>();
  private addressBook: AddressBook | null;
  private learned: LearnedNameSource | null;

  constructor(
    contacts: Contact[],
    addressBook: AddressBook | null = null,
    learned: LearnedNameSource | null = null,
  ) {
    this.addressBook = addressBook;
    this.learned = learned;
    for (const c of contacts) {
      const first = c.handles[0];
      if (!first) continue;
      const canon = normalizeHandle(first);
      if (c.name) this.canonToName.set(canon, c.name);
      const aliases: string[] = [];
      for (const h of c.handles) {
        const n = normalizeHandle(h);
        this.handleToCanon.set(n, canon);
        if (!aliases.includes(n)) aliases.push(n);
      }
      if (!aliases.includes(canon)) aliases.unshift(canon);
      this.canonToAliases.set(canon, aliases);
    }
  }

  /** Canonical handle for dedup. Returns the input normalized if unknown. */
  canon(handle: string): string {
    const n = normalizeHandle(handle);
    return this.handleToCanon.get(n) ?? n;
  }

  /** Pretty display name. Config beats AddressBook; both beat nothing. */
  displayName(handle: string): string | null {
    const fromConfig = this.canonToName.get(this.canon(handle));
    if (fromConfig) return fromConfig;
    return this.addressBook?.lookup(handle) ?? null;
  }

  /**
   * The name to SHOW for a handle in an envelope or transcript: the
   * displayName when the operator's books have one, else a name Edmund was
   * told, rendered with the number (`Pat (+15550100001)`) so it reads as
   * learned rather than as an address-book entry. Null when neither exists.
   *
   * Display only. Admission, addressing and anything else that asks "does
   * the operator know this person" must keep calling `displayName`: a learned
   * name is something a group member said, not something the operator saved.
   */
  label(handle: string): string | null {
    const known = this.displayName(handle);
    if (known) return known;
    const learned = this.learned?.get(this.canon(handle));
    return learned ? `${learned} (${this.canon(handle)})` : null;
  }

  /** Every handle the book knows about, normalized. Used for session scoping. */
  allKnownHandles(): string[] {
    return [...this.handleToCanon.keys()];
  }

  /**
   * Every name this book can put to a person — config entries AND the macOS
   * address book behind it.
   *
   * `allKnownHandles` only covers `[[contacts]]`, which exists for multi-handle
   * dedup and so holds a handful of people at most. Anything that needs to
   * recognise a NAME (the privacy scanner) has to see the address book too, or
   * it silently checks almost nothing and reports clean.
   */
  allKnownNames(): string[] {
    const names = new Set<string>(this.canonToName.values());
    for (const n of this.addressBook?.allNames() ?? []) names.add(n);
    return [...names];
  }

  /**
   * Everyone this book can put to `name`: config contacts and address-book
   * cards whose full or first name matches. One entry per person, never
   * merged across people, so an ambiguous name comes back as several
   * candidates for the caller to choose between. A name that matches is not
   * yet an identity; whoever acts on it should confirm when there are two.
   */
  peopleNamed(name: string): ContactCard[] {
    const wanted = name.trim().toLowerCase();
    const out: ContactCard[] = [];
    const seen = new Set<string>();
    for (const [canon, configName] of this.canonToName) {
      const full = configName.toLowerCase();
      if (full !== wanted && full.split(/\s+/)[0] !== wanted) continue;
      seen.add(canon);
      out.push({ name: configName, handles: this.aliasesFor(canon) });
    }
    for (const card of this.addressBook?.cardsNamed(name) ?? []) {
      const canon = this.canon(card.handles[0]!);
      if (seen.has(canon)) continue;
      seen.add(canon);
      out.push(card);
    }
    return out;
  }

  /**
   * All handles that share the same canonical (i.e. all aliases for one
   * person — phone + email + iCloud variants). Used by `list_contacts` to
   * show the full identity card for a person, and to look up name+email
   * given just a phone number.
   */
  aliasesFor(handle: string): string[] {
    const c = this.canon(handle);
    const cached = this.canonToAliases.get(c);
    if (cached) return [...cached];
    return [c];
  }
}
