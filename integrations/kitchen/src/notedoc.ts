/**
 * A note as a list of paragraphs, and Apple's clipboard format for one.
 *
 * Pure: everything that decides what a note should say lives here as a
 * function, and the browser (`icloud.ts`) only carries the result. That keeps
 * the parts that can lose a shopping list or un-tick a cart under unit test.
 *
 * Apple's clipboard HTML is the only way into the canvas editor. A paragraph is
 * a `<span>` carrying its styling as JSON in `data-tt`:
 *
 *   style 3    title (the note's first line, which is also its name)
 *   style 101  dash list item
 *   style 103  checklist item, `todo.done` holding the tick
 *   absent     body text; `fontHints: 1` plus bold font-weight makes a heading
 *
 * `todo.done` survives both copy and paste, so ticks made in a shop can be read
 * back and written back where they were.
 */

import { getAccount, householdTitle } from "./accounts.ts";
import { shopping } from "./shopping.ts";
import { escapeHtml } from "./util.ts";

export type BlockKind = "title" | "heading" | "todo" | "dash" | "text";

export type Block = {
  kind: BlockKind;
  text: string;
  /** Only meaningful for `todo`. */
  done?: boolean;
};

/**
 * The visible end of the block this integration owns.
 *
 * Visible text because Notes strips HTML comments, and free of characters that
 * HTML-escape so it round-trips byte for byte and can be found again.
 */
export const SENTINEL = "Add anything below this line and I will move it onto the list above.";

/**
 * Every earlier wording of the sentinel, matchable forever. A note keeps its
 * old wording until its next successful sync, and an unrecognised sentinel
 * reads as no sentinel, which prepends a second copy of the list.
 */
const OLD_SENTINELS = ["Everything below this line is yours. I only rewrite what is above it."];

/** The delimiter, in any wording it has ever had. */
export const isSentinel = (b: Block): boolean => {
  const t = b.text.trim();
  return t === SENTINEL || OLD_SENTINELS.includes(t);
};

/** Prefix of the one line that changes on every render whether anything did. */
const STAMP = "Updated ";

/* ------------------------------------------------------------------ *
 * Apple's clipboard HTML
 * ------------------------------------------------------------------ */

const attr = (o: unknown): string =>
  JSON.stringify(o).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function styleFor(b: Block): { para: Record<string, unknown>; bold: boolean } {
  switch (b.kind) {
    case "title":
      return { para: { alignment: 4, style: 3, writingDirection: 1 }, bold: true };
    case "heading":
      return { para: { alignment: 4, writingDirection: 1 }, bold: true };
    case "todo":
      return {
        para: { alignment: 4, style: 103, todo: { done: Boolean(b.done) } },
        bold: false,
      };
    case "dash":
      return { para: { alignment: 0, style: 101, writingDirection: 1 }, bold: false };
    default:
      return { para: { alignment: 4, writingDirection: 1 }, bold: false };
  }
}

/**
 * Render blocks as the HTML iCloud accepts on a paste. The newline inside each
 * span is required; without it the editor joins consecutive paragraphs.
 */
export function toAppleHtml(blocks: Block[]): string {
  const out: string[] = ['<meta charset="utf-8">'];
  let list: string[] | null = null;
  const flush = () => {
    if (list?.length) out.push(`<ul>${list.join("")}</ul>`);
    list = null;
  };

  for (const b of blocks) {
    const { para, bold } = styleFor(b);
    const span =
      `<span data-tt="${attr({ paragraphStyle: para, ...(bold ? { fontHints: 1 } : {}) })}"` +
      ` style="${bold ? "font-weight: bold; " : ""}white-space: pre-wrap;">${escapeHtml(b.text)}\n</span>`;
    if (b.kind === "todo" || b.kind === "dash") {
      list ??= [];
      list.push(`<li><p>${span}</p></li>`);
    } else {
      flush();
      out.push(`<p>${span}</p>`);
    }
  }
  flush();
  return out.join("");
}

const decode = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/**
 * Read Apple's clipboard HTML back into blocks, one `<p>` at a time (a line
 * with mixed formatting has several spans, and only the first carries the
 * paragraph style). Anything unrecognised becomes plain text, so an unknown
 * block below the sentinel is carried through rather than dropped.
 */
export function parseAppleHtml(html: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of html.split(/<\/p>/i)) {
    if (!/<span/i.test(chunk)) continue;

    const raw = chunk.match(/data-tt="([^"]*)"/i)?.[1];
    let para: { style?: number; todo?: { done?: unknown } } | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(decode(raw)) as {
          paragraphStyle?: { style?: number; todo?: { done?: unknown } };
        };
        para = parsed.paragraphStyle ?? null;
      } catch {
        // A style we cannot read is not a reason to lose the line.
        para = null;
      }
    }

    const text = decode(chunk.replace(/<[^>]*>/g, ""))
      .replace(/\n+$/, "")
      .trim();
    const bold = /font-weight:\s*bold/i.test(chunk);

    if (para?.style === 103) {
      blocks.push({ kind: "todo", text, done: Boolean(para.todo?.done) });
    } else if (para?.style === 101) {
      blocks.push({ kind: "dash", text });
    } else if (!text) {
    } else if (para?.style === 3) {
      blocks.push({ kind: "title", text });
    } else if (bold) {
      blocks.push({ kind: "heading", text });
    } else {
      blocks.push({ kind: "text", text });
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Splitting ours from theirs
 * ------------------------------------------------------------------ */

/** A line as its own identity, for noticing the same one twice. */
const ident = (b: Block): string => `${b.kind}:${b.text.trim().toLowerCase()}`;

/**
 * Split a note into the generated block and the household's own lines.
 *
 * Splits at the LAST sentinel, so a duplicated copy of the generated block
 * (from a paste that inserted, or merged replicas) lands in "ours" and the next
 * write replaces it; "theirs" is carried through verbatim forever, so a copy
 * there could never be repaired. Lines of theirs stranded above the last
 * sentinel are collected and moved below it, so a typed line is never dropped.
 *
 * A note with no sentinel was never written by this integration: all of it is
 * theirs, and the generated block goes above it.
 */
export function splitOwned(
  blocks: Block[],
  ourLines?: Set<string>,
): { ours: Block[]; theirs: Block[] } {
  // An empty set means "no record of what we last wrote", not "we wrote nothing";
  // the latter would re-adopt the whole generated block as hand-written lines.
  const known = ourLines?.size ? ourLines : null;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) if (isSentinel(blocks[i]!)) last = i;

  if (last === -1) {
    // The title is always ours: it is the note's name.
    const theirs = blocks[0]?.kind === "title" ? blocks.slice(1) : blocks;
    return { ours: [], theirs };
  }

  // A generated copy runs from a title to a sentinel. Anything above the last
  // sentinel but outside such a span is a stranded line of theirs. The walk
  // starts inside a span because the first line is always ours.
  const ours: Block[] = [];
  const stranded: Block[] = [];
  let generated = true;
  for (let i = 0; i < last; i++) {
    const b = blocks[i]!;
    if (isSentinel(b)) {
      generated = false;
      continue;
    }
    if (b.kind === "title") generated = true;
    // A line inside our span that we did not generate is somebody adding to the
    // top of the list; it is theirs, or the next write would delete it. Headings
    // and titles are structure and stay ours.
    const mine = !known || !wanted(b) || known.has(tickKey(b.text));
    (generated && mine ? ours : stranded).push(b);
  }

  // Stranded lines are usually already below too; dedupe so the note does not
  // grow a line per bad paste.
  const tail = blocks.slice(last + 1);
  const seen = new Set(tail.map(ident));
  const rescued: Block[] = [];
  for (const b of stranded) {
    if (seen.has(ident(b))) continue;
    seen.add(ident(b));
    rescued.push(b);
  }
  return { ours, theirs: [...rescued, ...tail] };
}

/** Tick state from a previous read, keyed so a reworded line still matches. */
export const tickKey = (text: string): string => text.trim().toLowerCase();

export function ticksIn(blocks: Block[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const b of blocks) if (b.kind === "todo") m.set(tickKey(b.text), Boolean(b.done));
  return m;
}

/* ------------------------------------------------------------------ *
 * What the note should say
 * ------------------------------------------------------------------ */

export const noteTitle = (account: string): string => {
  const acct = getAccount(account);
  const named = acct?.note_list?.trim();
  if (named) return named;
  return acct ? `${householdTitle(acct)} list` : "Kitchen list";
};

/** One line per item, as a shopper would read it. */
export function lineText(l: {
  name: string;
  amount: string | null;
  reason: string;
  why: string;
}): string {
  const amount = l.amount ? `, ${l.amount}` : "";
  const why = l.reason === "meal" ? ` (${l.why})` : "";
  return `${l.name}${amount}${why}`;
}

export type BuiltDoc = {
  blocks: Block[];
  /** Everything but the timestamp, so an unchanged list does not force a write. */
  signature: string;
  lines: number;
  /**
   * `tickKey` of every line this build generated. Persisted so the next read can
   * tell our lines from one a person typed into the middle of our block.
   */
  ourTexts: string[];
};

/**
 * Build the whole note: our block, the timestamp and sentinel, then their lines.
 * `previous` is the note as last read; it supplies their lines and the ticks,
 * so a rewrite never un-ticks what somebody put in the cart.
 */
export function buildDoc(
  account: string,
  previous: Block[] = [],
  now: Date = new Date(),
  ourLines?: Set<string>,
): BuiltDoc {
  const s = shopping(account);
  const ticks = ticksIn(previous);
  const { theirs } = splitOwned(previous, ourLines);

  const ourTexts: string[] = [];
  const ours: Block[] = [{ kind: "title", text: noteTitle(account) }];
  for (const g of s.groups) {
    ours.push({ kind: "heading", text: g.title });
    for (const l of g.lines) {
      const text = lineText(l);
      ours.push({ kind: "todo", text, done: ticks.get(tickKey(text)) ?? false });
      ourTexts.push(tickKey(text));
    }
  }
  if (!s.groups.length) ours.push({ kind: "text", text: "Nothing is out." });

  // The suggestion tray is deliberately not written to the note: it needs
  // answers, and in a note it is only more to read past in a shop.

  const stamp = now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const tail: Block[] = [
    { kind: "text", text: `${STAMP}${stamp}.` },
    { kind: "text", text: SENTINEL },
  ];

  // A line they typed below the sentinel is adopted onto the list and rendered
  // above, so their copy is dropped. Matched loosely because the list renders
  // a name plus an amount as one line.
  const rendered = new Set<string>();
  for (const l of s.lines) {
    rendered.add(tickKey(lineText(l)));
    rendered.add(tickKey(l.name));
    if (l.amount) rendered.add(tickKey(`${l.name}, ${l.amount}`));
  }
  const rest = theirs.filter((b) => !(wanted(b) && rendered.has(tickKey(b.text))));

  return {
    blocks: [...ours, ...tail, ...rest],
    signature: signatureOf(ours),
    lines: s.lines.length,
    ourTexts,
  };
}

/**
 * A stable fingerprint of the generated block: no timestamp, no ticks, no
 * sentinel, none of their lines.
 *
 * The timestamp and ticks change without the list changing, and including
 * them would rewrite the note while somebody is shopping from it. Callers must
 * fingerprint the note as read and as built over the same blocks, or the two
 * never match and every pass rewrites.
 */
export function signatureOf(blocks: Block[]): string {
  return blocks
    .filter((b) => !(b.kind === "text" && b.text.startsWith(STAMP)))
    .filter((b) => !isSentinel(b))
    .map((b) => `${b.kind}:${b.text}`)
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * Lines they wrote on a phone
 * ------------------------------------------------------------------ */

export type Adopted = { name: string; amount: string | null; text: string };

/** The longest a line can be and still plausibly be a thing you buy. */
const ITEM_MAX = 80;

/**
 * Whether a line below the sentinel is something they want bought.
 *
 * Plain text counts, not only checklist items: typing under the sentinel on a
 * phone continues its plain-text style. Headings, the timestamp and anything
 * long enough to be a sentence stay where they were written.
 */
export const wanted = (b: Block): boolean => {
  const text = b.text.trim();
  return (
    (b.kind === "todo" || b.kind === "dash" || b.kind === "text") &&
    !!text &&
    text.length <= ITEM_MAX &&
    !text.startsWith(STAMP)
  );
};

/**
 * Lines somebody typed below the sentinel, parsed for the real list, so an
 * addition made on a phone reaches the site, the tools and the trip cost.
 */
export function adoptable(theirs: Block[]): Adopted[] {
  const out: Adopted[] = [];
  const seen = new Set<string>();
  for (const b of theirs) {
    if (!wanted(b)) continue;
    const text = b.text.trim();
    if (seen.has(tickKey(text))) continue;
    seen.add(tickKey(text));
    out.push({ ...splitAmount(text), text });
  }
  return out;
}

/** What a quantity looks like when it follows a comma. */
const AMOUNT = /^(?:\d|½|¼|¾|a |an |one |two |three |half |some |a few )/i;

/**
 * Split "scallions, 1 bunch" into a name and an amount. "Bread, milk" is two
 * things, not bread in an amount of milk, so the tail must read as a quantity;
 * otherwise the whole line is kept as the name.
 */
function splitAmount(text: string): { name: string; amount: string | null } {
  const at = text.lastIndexOf(", ");
  if (at <= 0) return { name: text, amount: null };
  const tail = text.slice(at + 2).trim();
  if (!tail || tail.length > 24 || !AMOUNT.test(tail)) return { name: text, amount: null };
  return { name: text.slice(0, at).trim(), amount: tail };
}

/* ------------------------------------------------------------------ *
 * Did the write land
 * ------------------------------------------------------------------ */

/**
 * Whether the note holds exactly the pasted lines, once each.
 *
 * Catches a paste that inserted instead of replacing, which looks like a clean
 * write from every other angle. Compared as a multiset of lines folded for
 * typographic substitutions, plus a count of checklist lines, since a paste
 * that landed as plain text would otherwise match word for word.
 */
export function sameDoc(want: Block[], got: Block[]): boolean {
  const tally = (bs: Block[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const b of bs) {
      const k = fold(b.text);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const a = tally(want);
  const b = tally(got);
  if (a.size !== b.size) return false;
  for (const [k, n] of a) if (b.get(k) !== n) return false;
  const todos = (bs: Block[]) => bs.filter((x) => x.kind === "todo").length;
  return todos(want) === todos(got);
}

const fold = (s: string): string =>
  s
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
