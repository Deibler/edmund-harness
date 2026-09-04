/**
 * A note as a list of paragraphs, and Apple's wire format for one.
 *
 * Pure on purpose. The interesting failure in this whole feature is losing
 * somebody's shopping list or silently un-ticking things they ticked in a shop,
 * and neither is something to discover by looking at a phone. Everything that
 * decides what the note should say is here and is a function; the browser in
 * `icloud.ts` only carries the result.
 *
 * The format is Apple's own clipboard flavour, which is the only way in — the
 * iCloud editor paints to a canvas, so there is no HTML to set and no markup
 * AppleScript can smuggle past it. A paragraph is a `<span>` carrying its
 * styling as JSON in `data-tt`:
 *
 *   style 3    title (the note's first line, which is also its name)
 *   style 101  dash list item
 *   style 103  checklist item, with `todo.done` holding the tick
 *   absent     body text; `fontHints: 1` plus a bold font-weight makes a heading
 *
 * `todo.done` is the whole point. It survives a copy, which means a tick made
 * in a supermarket can be read back, and it survives a paste, which means a
 * rewrite can put it back exactly where it was.
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
 * Deliberately free of apostrophes and punctuation that HTML-escapes, because
 * it has to survive a round trip byte for byte to be findable again.
 *
 * It is visible text rather than a comment because Notes strips HTML comments,
 * which is how an early version lost its own delimiter and appended a second
 * copy of the list on the next push.
 */
export const SENTINEL = "Add anything below this line and I will move it onto the list above.";

/**
 * Wordings this line has had before, kept matchable forever.
 *
 * Changing the text is otherwise indistinguishable from the delimiter going
 * missing: the next sync finds no sentinel, decides the whole note is somebody
 * else's, and prepends a second copy of the list above it. Every note ever
 * written carries the wording it was written with until the next successful
 * sync, and some of those phones are asleep for a week.
 */
const OLD_SENTINELS = [
  // Promised the lines below were never touched. They are now: a list item
  // written down there is adopted onto the real list, which is the only way
  // adding something on a phone can reach anything but the phone.
  "Everything below this line is yours. I only rewrite what is above it.",
];

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
 * Render blocks as the HTML iCloud accepts on a paste.
 *
 * The trailing newline inside each span is not decorative. Without it the
 * editor runs consecutive paragraphs together into one line, which turns a
 * fifteen item list into a single unreadable sentence.
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
 * Read Apple's clipboard HTML back into blocks.
 *
 * Works paragraph by paragraph rather than by parsing the whole tree, because
 * one paragraph can hold several spans when a line has mixed formatting and
 * only the first carries the paragraph style. Anything unrecognised becomes
 * plain text, which is the safe direction: an unknown block below the sentinel
 * is copied through untouched instead of being dropped.
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
 * Which blocks are the generated list, and which are the household's own.
 *
 * The obvious rule — everything after the FIRST sentinel is theirs — has a hole
 * that cost a real note. If anything ever leaves a second copy of the generated
 * block below that sentinel (a paste that appended instead of replacing, or two
 * replicas of the note merging), the copy lands in "theirs". And "theirs" is
 * sacred: it is carried through verbatim on every write, forever. The note then
 * cannot repair itself, because the part that is wrong is the one part nothing
 * is allowed to touch.
 *
 * So the split reads the LAST sentinel, which puts every duplicated copy inside
 * the generated block where the next write replaces it. On its own that would
 * trade one failure for a worse one — a line of theirs stranded above the last
 * sentinel by a bad paste would be destroyed — so those are collected as they
 * are passed and put back below. A line somebody typed is never dropped; a copy
 * of our own block always is.
 *
 * A note with no sentinel at all has never been written by this integration, so
 * all of it is theirs and the generated block goes ABOVE — a list somebody
 * wrote by hand outranks a derived one, and prepending is the only move that
 * cannot destroy it.
 */
export function splitOwned(
  blocks: Block[],
  ourLines?: Set<string>,
): { ours: Block[]; theirs: Block[] } {
  // An empty set is "we have no record of what we last wrote", not "we wrote
  // nothing". Treating it as the latter would strand the entire generated block
  // into theirs on the first pass after this shipped and re-adopt every staple
  // as a hand-written line.
  const known = ourLines?.size ? ourLines : null;
  let last = -1;
  for (let i = 0; i < blocks.length; i++) if (isSentinel(blocks[i]!)) last = i;

  if (last === -1) {
    // The title line is ours whatever else is true: it is the note's name, and
    // leaving a stale one below would rename the note on the next write.
    const theirs = blocks[0]?.kind === "title" ? blocks.slice(1) : blocks;
    return { ours: [], theirs };
  }

  // A generated copy opens with the note's title and closes with a sentinel, so
  // the span between the two is ours. Anything outside one of those spans, but
  // still above the last sentinel, is a line of theirs that got stranded there.
  // The walk starts inside a span because the note's first line always is ours.
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
    // A line inside our own span that we did not generate is somebody adding to
    // the list at the top of the list, which is where a person naturally adds to
    // a list. It used to be classified as ours and destroyed by the next write,
    // with no trace anywhere: not adopted, not carried through, just gone. That
    // is the complaint. Headings and titles stay ours whatever happens, because
    // they are structure rather than shopping.
    const mine = !known || !wanted(b) || known.has(tickKey(b.text));
    (generated && mine ? ours : stranded).push(b);
  }

  // Stranded lines are almost always already down there too, because every
  // write copies "theirs" through: putting both back would grow the note by a
  // line every time somebody's paste went wrong.
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
   * `tickKey` of every line this build generated.
   *
   * Persisted so the NEXT read can tell our block's own lines apart from one a
   * person typed into the middle of it. Nothing else can: the signature is a
   * hash, and the current shopping list cannot distinguish a human addition
   * from a line we generated last week that has since come off.
   */
  ourTexts: string[];
};

/**
 * Build the whole note: our block, the sentinel, then whatever they wrote.
 *
 * `previous` is the note as it was last read. It is used for exactly one thing
 * — carrying ticks across — and that is the difference between a list somebody
 * can shop from and one that helpfully un-ticks the eggs while they are in the
 * dairy aisle.
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

  // The suggestion tray is deliberately NOT exported. It needs two buttons and
  // an answer that sticks; as text in a note it would just be more to read past
  // in a supermarket, which is the exact failure the split exists to remove.

  const stamp = now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const tail: Block[] = [
    { kind: "text", text: `${STAMP}${stamp}.` },
    { kind: "text", text: SENTINEL },
  ];

  // Nothing appears twice in one note. A line somebody wrote below the sentinel
  // is adopted onto the real list and then rendered above it like any other, so
  // the copy they typed has to go — otherwise every adopted line reads as two
  // of the same thing, once ticked and once not. Matched loosely because the
  // list re-renders "scallions" plus an amount as one line.
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
 * A stable fingerprint of the block this integration owns.
 *
 * Deliberately covers ONLY the generated part, and deliberately drops the
 * timestamp and every tick.
 *
 * The timestamp changes on every render and a tick changes whenever somebody
 * shops, so including either would have the watch pass rewriting the note
 * continuously — and a rewrite while a person is standing in an aisle is
 * exactly when that does the most damage. Their own lines are excluded because
 * this integration never rewrites them, so a change down there is not a reason
 * to touch anything; the periodic refresh is what catches real drift.
 *
 * Compare like with like. An earlier version measured the note as read
 * (sentinel included) against the note as built (sentinel excluded), so the two
 * could never match and every single pass wrote the note again.
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
 * Is this line below the sentinel something they want bought?
 *
 * Deliberately not restricted to checklist lines, which was the first rule and
 * would have fixed nothing. Typing below the sentinel on a phone produces plain
 * text, because the line above it is plain text and that is what Notes
 * continues — so "only adopt checklist items" is a feature that almost never
 * fires, and the three lines that started this were all plain text.
 *
 * So the rule is the one the sentinel now states out loud: anything written
 * down there gets picked up. A heading is structure rather than shopping, and
 * anything long enough to be a sentence is a note to the household rather than
 * a thing on a shelf, so those two stay exactly where they were written.
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
 * Lines somebody typed below the sentinel, ready for the real list.
 *
 * Adding something to the note on a phone is the most natural way there is to
 * put something on this list, and until this existed it was the one way that
 * reached nothing: the line sat below the sentinel, got carried through on
 * every write, and was invisible to the site, to the tools and to anything that
 * counts what a trip will cost. It existed on the phone it was typed on and
 * nowhere else.
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
 * "scallions, 1 bunch" is a thing and a quantity. "Bread, milk" is two things.
 *
 * Guessing wrong in the second direction is the expensive one: it would put
 * "Bread" on the list in an amount of "milk" and quietly lose the milk. So the
 * tail has to actually read as a quantity, and when it does not the whole line
 * is kept as the name — a slightly long line on a list beats a missing one.
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
 * Does the note now say exactly what was pasted into it, once each?
 *
 * The failure this exists for is a paste that INSERTS instead of replacing. It
 * looks like a clean write from every angle this code can see — the editor
 * takes the keystroke, the app saves, nothing throws — and the only evidence is
 * that the note now holds the list twice. Unchecked, the sync then records the
 * note as current, so the next pass does not even open it; that is how one bad
 * paste became ten stacked copies of a shopping list that nobody on this side
 * could see.
 *
 * Compared as a multiset of lines rather than a sequence, and folded for the
 * typographic substitutions an editor is entitled to make, because the question
 * being asked is "is anything here twice, or missing" and not "did Apple keep
 * my apostrophes". Checklist lines are counted separately: a paste that landed
 * as plain text would match word for word and leave a list nobody can tick.
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
