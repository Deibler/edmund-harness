/**
 * The icon set, as inline SVG strings.
 *
 * Inline rather than a sprite sheet or an icon font: the page is one static
 * file behind a token, so every extra request would need the key appended to it
 * the same way images do, and an icon that 403s is an invisible button.
 *
 * Moved out of `site.ts` on 2026-08-17 unedited.
 */

export const I = {
  filter: `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M7 12h10M11 18h2"/></svg>`,
  menu: `<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
  close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"
    stroke-linejoin="round"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 11.5a8.4 8.4 0 01-9 8.4 9.5 9.5 0 01-3-.5L3 21l1.6-4.4A8.3 8.3 0 013 11.5a8.5 8.5 0 019-8.4 8.4 8.4 0 019 8.4z"/></svg>`,
  tick: `<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>`,
  chev: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>`,
  /** There is more you can do to this row: change it, or take it off. */
  more: `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg>`,
  /**
   * A served cloche on a waiter's hand: this dish has been cooked here before
   * and somebody wrote it down, so there is a real page behind it. Drawn as a
   * filled silhouette rather than an outline so it reads at 18px on a photo,
   * which is the only size it is ever shown at.
   */
  /**
   * Three arrows chasing each other: this dish is half of a cook-once-eat-twice
   * pair, either the one that makes the leftovers or the one that eats them.
   */
  recycle: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M12 2.4l4.4 7H13.6v3.8h-3.2V9.4H7.6z"/>
    <path d="M12 2.4l4.4 7H13.6v3.8h-3.2V9.4H7.6z" transform="rotate(120 12 12)"/>
    <path d="M12 2.4l4.4 7H13.6v3.8h-3.2V9.4H7.6z" transform="rotate(240 12 12)"/>
  </svg>`,
  /** One road splitting in two: other written takes on this same dish exist. */
  fork: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 21.2v-6.6c0-3.6 2.9-6.6 6.6-6.6h1.2"/>
    <path d="M12 14.6c0-3.6-2.9-6.6-6.6-6.6H4.2"/>
    <path d="M17.2 4.9L20.4 8l-3.2 3.1"/><path d="M6.8 4.9L3.6 8l3.2 3.1"/>
  </svg>`,
  /** How good for you it is, on the household's own 0 to 5 opinion scale. */
  leaf: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M20.6 3.2c.3 9.8-4.4 15-11.5 15-1.5 0-2.9-.3-4.1-.9C6.1 8.9 12 4.3 20.6 3.2z"/>
    <path d="M3.4 21.4a1.05 1.05 0 01-.5-1.9C5.6 15.2 8.6 12 12.2 9.6a1.05 1.05 0 011.2 1.7
      C10 13.5 7.2 16.5 4.7 20.6a1.05 1.05 0 01-1.3.8z"/>
  </svg>`,
  cloche: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <circle cx="12" cy="4.1" r="1.7"/>
    <path d="M3.4 13.9a8.6 8.6 0 0117.2 0z"/>
    <rect x="1.9" y="15.1" width="20.2" height="2.2" rx="1.1"/>
    <path d="M2.6 19.1a1.05 1.05 0 010-2.1h6.9c.9 0 1.7.4 2.3 1l.7.7a1 1 0 01-.75 1.7z"/>
  </svg>`,
};
