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
 */

type Section = { heading: string | null; lines: string[] };

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const DATED_BULLET = /^\s*[-*]\s+(?:\*\*)?(\d{4}-\d{2}-\d{2})/;

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

/**
 * Keep a section within `budget` chars. A section of dated bullets keeps its
 * newest bullets (in their original order) and its undated lines; anything
 * else keeps its head.
 */
function fitSection(s: Section, budget: number): string {
  const full = render(s);
  if (full.length <= budget) return full;
  const dated = s.lines
    .map((line, i) => ({ line, i, date: line.match(DATED_BULLET)?.[1] ?? null }))
    .filter((x) => x.date !== null);
  if (dated.length >= 2) {
    const fixed = s.lines.filter((l) => !DATED_BULLET.test(l) && l.trim()).slice(0, 2);
    let used = (s.heading?.length ?? 0) + fixed.join("\n").length + 60;
    const keep = new Set<number>();
    for (const x of [...dated].sort((a, b) => (a.date! < b.date! ? 1 : -1))) {
      if (used + x.line.length + 1 > budget && keep.size > 0) break;
      keep.add(x.i);
      used += x.line.length + 1;
    }
    const omitted = dated.length - keep.size;
    const kept = s.lines.filter((_, i) => keep.has(i));
    return [s.heading, ...fixed, `(${omitted} older entries omitted)`, ...kept]
      .filter((l) => l !== null)
      .join("\n");
  }
  return `${full.slice(0, Math.max(0, budget - 2))}…`;
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
  openItemsShare = 0.4,
): string {
  if (body.length <= budget) return body.trim();
  const sections = splitSections(body);
  const isOpen = (s: Section) => /^##\s+Open Items\b/i.test(s.heading ?? "");
  const fitted = new Map<Section, string>();
  let left = budget - 120;
  const open = sections.find(isOpen);
  if (open) {
    const text = fitSection(open, Math.floor(budget * openItemsShare));
    fitted.set(open, text);
    left -= text.length;
  }
  const rest = sections.filter((s) => !isOpen(s));
  rest.forEach((s, i) => {
    const share = Math.max(0, Math.floor(left / (rest.length - i)));
    const text = share > 40 ? fitSection(s, share) : "";
    fitted.set(s, text);
    left -= text.length;
  });
  const note = `(excerpt: ${budget} of ${body.length} chars${path ? `; full file: ${path}` : ""})`;
  return [...sections.map((s) => fitted.get(s) ?? "").filter(Boolean), note].join("\n\n");
}

/**
 * The ghost's running notes within `budget` chars. Dated sections are kept
 * newest first by the date in their heading, whatever order the file uses.
 * Undated notes keep both ends, since nothing says which end is current.
 */
export function excerptNotes(body: string, budget: number, path?: string): string {
  const text = body.trim();
  if (text.length <= budget) return text;
  const note = `(excerpt of ${text.length} chars, newest kept${path ? `; full file: ${path}` : ""} — keep it short)`;
  const sections = splitSections(text);
  const dated = sections
    .map((s, i) => ({ s, i, date: s.heading?.match(DATE)?.[1] ?? null }))
    .filter((x) => x.date !== null);
  if (dated.length >= 2) {
    const keep = new Set<number>();
    let used = note.length;
    for (const x of [...dated].sort((a, b) =>
      a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : b.i - a.i,
    )) {
      const len = render(x.s).length + 2;
      if (used + len > budget) {
        if (keep.size === 0) keep.add(x.i);
        break;
      }
      keep.add(x.i);
      used += len;
    }
    const kept = sections
      .map((s, i) => (keep.has(i) ? render(s) : null))
      .filter((s): s is string => s !== null)
      .map((s) => (s.length > budget ? `${s.slice(0, budget - note.length - 4)}…` : s));
    return [note, ...kept].join("\n\n");
  }
  const half = Math.floor((budget - note.length - 10) / 2);
  return [note, `${text.slice(0, half)}…`, `…${text.slice(-half)}`].join("\n");
}
