/**
 * Bounded excerpts of the long markdown the ghost reads every tick: the
 * person file and its own running notes. Both used to be cut to their first
 * N characters, which keeps the wrong end. Measured 2026-10-23: 14 of the 15
 * person files over the 4000-byte cut lost their whole Open Items section
 * (the section GHOST.md calls the highest-signal one), and ghost notes are
 * written in either order, so a head cut dropped the newest entries of every
 * file that appends at the bottom.
 *
 * Dates are the key: a dated bullet (`- **2026-10-08** — …`) or a dated
 * heading (`## 2026-10-18 update`) says what is newest, wherever it sits.
 * Nothing undated is ranked by age: an undated line or section is a
 * standing item (an open item with no date, what the ghost is watching, its
 * snooze plan), so it is kept ahead of dated history.
 */

type Section = { heading: string | null; lines: string[] };

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const DATED_BULLET = /^\s*[-*]\s+(?:\*\*)?(\d{4}-\d{2}-\d{2})/;
/** "(NNN entries omitted)" and the newline before it, at most. */
const MARKER_RESERVE = 32;

function splitSections(body: string): Section[] {
  const out: Section[] = [{ heading: null, lines: [] }];
  for (const line of body.split("\n")) {
    if (/^## /.test(line)) out.push({ heading: line, lines: [] });
    else out[out.length - 1]!.lines.push(line);
  }
  return out.filter((s) => s.heading !== null || s.lines.some((l) => l.trim()));
}

function render(s: Section): string {
  return [s.heading, ...s.lines]
    .filter((l) => l !== null)
    .join("\n")
    .trim();
}

const newestFirst = <T extends { date: string | null; i: number }>(a: T, b: T) =>
  a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : b.i - a.i;

/**
 * Keep a section within `budget` chars. A section of dated bullets keeps
 * every undated line it can (leaving room for the newest dated bullet),
 * then its newest dated bullets, all in their original order. Undated
 * lines are open items with no date (up to 13 in one live Open Items),
 * not decoration. Anything else keeps its head.
 */
function fitSection(s: Section, budget: number): string {
  const full = render(s);
  if (full.length <= budget) return full;
  const items = s.lines
    .map((line, i) => ({ line, i, date: line.match(DATED_BULLET)?.[1] ?? null }))
    .filter((x) => x.line.trim());
  const dated = items.filter((x) => x.date !== null);
  if (dated.length >= 2) {
    const undated = items.filter((x) => x.date === null);
    const keep = new Set<number>();
    let used = (s.heading ? s.heading.length + 1 : 0) + MARKER_RESERVE;
    const take = (x: (typeof items)[number], limit: number) => {
      if (keep.has(x.i) || used + x.line.length + 1 > limit) return false;
      keep.add(x.i);
      used += x.line.length + 1;
      return true;
    };
    const byAge = [...dated].sort(newestFirst);
    for (const x of undated) if (!take(x, budget - byAge[0]!.line.length - 1)) break;
    for (const x of byAge) if (!take(x, budget)) break;
    const omitted = items.length - keep.size;
    const kept = s.lines.filter((_, i) => keep.has(i));
    const out = [s.heading, ...kept, omitted > 0 ? `(${omitted} entries omitted)` : null]
      .filter((l) => l !== null)
      .join("\n");
    // A share too small for the heading and the marker: fall to the head.
    if (out.length <= budget) return out;
  }
  return budget > 0 ? `${full.slice(0, budget - 1)}…` : "";
}

/**
 * Fit sections into `budget` chars between them, smallest first: each gets
 * an even share of what is left, so a short section is kept whole and what
 * it doesn't use goes to the long ones. A share under 40 chars drops it.
 */
function fairFit<T extends { s: Section }>(items: T[], budget: number): Map<T, string> {
  const out = new Map<T, string>();
  let left = budget;
  const bySize = [...items].sort((a, b) => render(a.s).length - render(b.s).length);
  bySize.forEach((x, k) => {
    const share = Math.floor(left / (bySize.length - k));
    const t = share > 40 ? fitSection(x.s, share) : "";
    out.set(x, t);
    left -= t.length;
  });
  return out;
}

/**
 * A person file within `budget` chars. Open Items is fitted first and gets
 * up to `openItemsShare` of the budget; every other section then shares
 * what is left, in document order, so no section disappears behind a long
 * one. `path`, when given, is named so a ghost with Read can open the rest.
 */
export function excerptPersonFile(
  body: string,
  budget: number,
  path?: string,
  openItemsShare = 0.5,
): string {
  if (body.length <= budget) return body.trim();
  const sections = splitSections(body);
  const note = `(excerpt: ${budget} of ${body.length} chars${path ? `; full file: ${path}` : ""})`;
  const isOpen = (s: Section) => /^##\s+Open Items\b/i.test(s.heading ?? "");
  const fitted = new Map<Section, string>();
  // Every section and the note are joined by a blank line.
  let left = budget - note.length - 2 * sections.length;
  const open = sections.find(isOpen);
  if (open) {
    const text = fitSection(open, Math.floor(left * openItemsShare));
    fitted.set(open, text);
    left -= text.length;
  }
  const rest = sections.filter((s) => !isOpen(s)).map((s) => ({ s }));
  for (const [x, text] of fairFit(rest, left)) fitted.set(x.s, text);
  return [...sections.map((s) => fitted.get(s) ?? "").filter(Boolean), note].join("\n\n");
}

/**
 * The ghost's running notes within `budget` chars. Standing sections (the
 * preamble and every section without a date in its heading: what it is
 * watching, what it leaves to others, its plan) are kept first, up to 70% of
 * the budget. Dated sections are history: newest first by the date in their
 * heading, whatever order the file uses, and the one at the boundary is cut
 * rather than skipped.
 */
export function excerptNotes(body: string, budget: number, path?: string): string {
  const text = body.trim();
  if (text.length <= budget) return text;
  const note = `(excerpt of ${text.length} chars: standing sections first, then dated entries newest first${path ? `; full file: ${path}` : ""} — keep it short)`;
  const parts = splitSections(text);
  if (parts.length === 1 && parts[0]!.heading === null) {
    // No headings: nothing says which end is current, so keep both.
    const half = Math.floor((budget - note.length - 10) / 2);
    return [note, `${text.slice(0, half)}…`, `…${text.slice(-half)}`].join("\n");
  }
  const sections = parts.map((s, i) => ({ s, i, date: s.heading?.match(DATE)?.[1] ?? null }));
  const standing = sections.filter((x) => x.date === null);
  const history = sections.filter((x) => x.date !== null);
  const out = new Map<number, string>();
  let left = budget - note.length - 2 * (sections.length + 1) - MARKER_RESERVE;
  for (const [x, t] of fairFit(standing, history.length > 0 ? Math.floor(left * 0.7) : left)) {
    out.set(x.i, t);
    left -= t.length;
  }
  let omitted = 0;
  for (const x of [...history].sort(newestFirst)) {
    if (left < 200) {
      omitted++;
      continue;
    }
    const t = fitSection(x.s, left);
    out.set(x.i, t);
    left -= t.length;
  }
  return [
    note,
    ...sections.map((x) => out.get(x.i) ?? "").filter(Boolean),
    omitted > 0 ? `(${omitted} older dated entries omitted)` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
