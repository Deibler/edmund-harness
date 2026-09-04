import type { Contact } from "../config/config.ts";
import type { AddressBook } from "./address-book.ts";
import { normalizeHandle } from "./key.ts";

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

  constructor(contacts: Contact[], addressBook: AddressBook | null = null) {
    this.addressBook = addressBook;
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
