/**
 * The note as a document, which is where this feature can actually lose data.
 *
 * The browser driving cannot be unit tested — it is a real UI on somebody
 * else's site — but everything that DECIDES what a note should say is pure, and
 * it is pure precisely so this file can exist. The failures worth pinning are
 * the quiet ones: dropping a line somebody typed, un-ticking something they
 * ticked in a shop, or rewriting the note on every pass because the fingerprint
 * includes a clock.
 */

import { describe, expect, test } from "bun:test";
import {
  type Block,
  SENTINEL,
  adoptable,
  parseAppleHtml,
  sameDoc,
  signatureOf,
  splitOwned,
  tickKey,
  ticksIn,
  toAppleHtml,
} from "../src/notedoc.ts";

/** The wording the sentinel shipped with, still sitting in real notes. */
const OLD_SENTINEL = "Everything below this line is yours. I only rewrite what is above it.";

/** One generated block, as every write lays it out. */
const generated = (...items: string[]): Block[] => [
  { kind: "title", text: "Kitchen" },
  { kind: "heading", text: "Out of something you keep" },
  ...items.map((text): Block => ({ kind: "todo", text, done: false })),
  { kind: "text", text: "Updated Aug 19, 2026 at 8:47 PM." },
  { kind: "text", text: SENTINEL },
];

/** A note as iCloud actually hands it over, trimmed to the shapes that matter. */
const APPLE_HTML = toAppleHtml([
  { kind: "title", text: "Sam and Alex's Kitchen list" },
  { kind: "heading", text: "Out of something you keep" },
  { kind: "todo", text: "Chicken broth", done: false },
  { kind: "todo", text: "Avocados", done: true },
  { kind: "text", text: SENTINEL },
  { kind: "todo", text: "beer", done: false },
  { kind: "dash", text: "their own dash line" },
]);

describe("Apple's clipboard format", () => {
  test("a document survives a round trip unchanged", () => {
    const blocks: Block[] = [
      { kind: "title", text: "A list" },
      { kind: "heading", text: "A heading" },
      { kind: "todo", text: "unticked thing", done: false },
      { kind: "todo", text: "ticked thing", done: true },
      { kind: "dash", text: "a dash line" },
      { kind: "text", text: "plain prose" },
    ];
    expect(parseAppleHtml(toAppleHtml(blocks))).toEqual(blocks);
  });

  test("tick state is what round-trips, not just the words", () => {
    // The entire point. A checklist that comes back un-ticked would un-tick
    // somebody's shopping mid-aisle on the next sync.
    const parsed = parseAppleHtml(APPLE_HTML);
    expect(ticksIn(parsed).get(tickKey("Avocados"))).toBe(true);
    expect(ticksIn(parsed).get(tickKey("Chicken broth"))).toBe(false);
  });

  test("apostrophes and ampersands come back as themselves", () => {
    // These go out HTML-escaped and are read back off a clipboard, so a missing
    // decode step shows up as "Alex&#39;s" on somebody's phone.
    const blocks: Block[] = [{ kind: "todo", text: "Alex's M&M's <big>", done: false }];
    expect(parseAppleHtml(toAppleHtml(blocks))).toEqual(blocks);
  });

  test("every line ends in a newline inside its span", () => {
    // Without it the editor runs consecutive paragraphs into one line, which
    // turns a fifteen item list into a single unreadable sentence.
    const html = toAppleHtml([{ kind: "todo", text: "milk", done: false }]);
    expect(html).toContain("milk\n</span>");
  });

  test("consecutive list items share one <ul>, and prose closes it", () => {
    const html = toAppleHtml([
      { kind: "todo", text: "a", done: false },
      { kind: "todo", text: "b", done: false },
      { kind: "text", text: "after" },
      { kind: "todo", text: "c", done: false },
    ]);
    expect(html.match(/<ul>/g)?.length).toBe(2);
  });

  test("blank paragraphs are dropped rather than accumulated", () => {
    // The editor inserts spacing paragraphs of its own. Keeping them would grow
    // the note by a blank line on every single rewrite.
    const withBlank =
      '<meta charset="utf-8">' +
      '<p><span data-tt="{&quot;paragraphStyle&quot;:{}}" style="white-space: pre-wrap;">\n</span></p>' +
      '<p><span data-tt="{&quot;paragraphStyle&quot;:{}}" style="white-space: pre-wrap;">real\n</span></p>';
    expect(parseAppleHtml(withBlank)).toEqual([{ kind: "text", text: "real" }]);
  });

  test("an unreadable style becomes text instead of vanishing", () => {
    // Below the sentinel this is somebody's own writing. Losing a line because
    // Apple shipped a paragraph style we do not recognise would be unforgivable.
    const odd =
      '<meta charset="utf-8">' +
      '<p><span data-tt="{not json at all}" style="white-space: pre-wrap;">keep me\n</span></p>';
    expect(parseAppleHtml(odd)).toEqual([{ kind: "text", text: "keep me" }]);
  });
});

describe("whose lines are whose", () => {
  test("everything after the sentinel is theirs and comes back untouched", () => {
    const { ours, theirs } = splitOwned(parseAppleHtml(APPLE_HTML));
    expect(ours.map((b) => b.text)).toContain("Chicken broth");
    expect(theirs).toEqual([
      { kind: "todo", text: "beer", done: false },
      { kind: "dash", text: "their own dash line" },
    ]);
  });

  test("the sentinel itself belongs to neither side", () => {
    const { ours, theirs } = splitOwned(parseAppleHtml(APPLE_HTML));
    expect([...ours, ...theirs].some((b) => b.text === SENTINEL)).toBe(false);
  });

  test("a note we have never written is entirely theirs", () => {
    // Adopting a note somebody already made and shared. Their list must end up
    // BELOW the generated block, never replaced by it.
    const { ours, theirs } = splitOwned([
      { kind: "title", text: "Groceries" },
      { kind: "todo", text: "eggs", done: false },
    ]);
    expect(ours).toEqual([]);
    expect(theirs).toEqual([{ kind: "todo", text: "eggs", done: false }]);
  });

  test("but their stale title is not kept, or it would rename the note", () => {
    const { theirs } = splitOwned([
      { kind: "title", text: "Old name" },
      { kind: "text", text: "body" },
    ]);
    expect(theirs.some((b) => b.kind === "title")).toBe(false);
  });

  test("rewriting the same note over and over is stable", () => {
    // The regression this replaces: the delimiter used to be an HTML comment,
    // Notes strips those, so the second push could not find the first and
    // appended a whole second copy of the list. Three rounds, because a bug of
    // that shape usually survives one.
    const ours: Block[] = [
      { kind: "title", text: "Kitchen" },
      { kind: "heading", text: "Out of something you keep" },
      { kind: "todo", text: "milk", done: false },
    ];
    const rewrite = (note: Block[]): Block[] => {
      const { theirs } = splitOwned(note);
      return parseAppleHtml(toAppleHtml([...ours, { kind: "text", text: SENTINEL }, ...theirs]));
    };

    let note: Block[] = [{ kind: "todo", text: "paper towels", done: true }];
    for (let i = 0; i < 3; i++) note = rewrite(note);

    expect(note.filter((b) => b.text === "Kitchen")).toHaveLength(1);
    expect(note.filter((b) => b.text === SENTINEL)).toHaveLength(1);
    // Theirs survived every round, tick and all.
    expect(note.filter((b) => b.text === "paper towels")).toEqual([
      { kind: "todo", text: "paper towels", done: true },
    ]);
  });
});

describe("deciding whether anything changed", () => {
  test("the timestamp does not count as a change", () => {
    // This is what stops the watch pass rewriting the note every ten seconds,
    // and a rewrite while somebody is standing in an aisle is the worst thing
    // this feature can do.
    const a: Block[] = [{ kind: "text", text: "Updated Aug 17, 2026 at 1:23 PM." }];
    const b: Block[] = [{ kind: "text", text: "Updated Aug 17, 2026 at 9:99 PM." }];
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("neither does ticking something off", () => {
    // A tick is somebody shopping, not the list changing. Treating it as a
    // change would make the act of ticking trigger the rewrite that erases it.
    const before: Block[] = [{ kind: "todo", text: "milk", done: false }];
    const after: Block[] = [{ kind: "todo", text: "milk", done: true }];
    expect(signatureOf(before)).toBe(signatureOf(after));
  });

  test("a note read back from what we wrote reports no change", () => {
    // The bug this pins: the note as READ carries the sentinel and the
    // timestamp, the block as BUILT does not, so comparing the two could never
    // match and every single pass rewrote the note — including, eventually, one
    // in the middle of somebody's shop.
    const ours: Block[] = [
      { kind: "title", text: "Kitchen" },
      { kind: "heading", text: "Out of something you keep" },
      { kind: "todo", text: "milk", done: false },
    ];
    const onDisk = parseAppleHtml(
      toAppleHtml([
        ...ours,
        { kind: "text", text: "Updated Aug 17, 2026 at 2:26 PM." },
        { kind: "text", text: SENTINEL },
        { kind: "todo", text: "their own line", done: true },
      ]),
    );
    expect(signatureOf(splitOwned(onDisk).ours)).toBe(signatureOf(ours));
  });

  test("an actual new line does count", () => {
    expect(signatureOf([{ kind: "todo", text: "milk" }])).not.toBe(
      signatureOf([
        { kind: "todo", text: "milk" },
        { kind: "todo", text: "eggs" },
      ]),
    );
  });

  test("so does a line changing kind", () => {
    expect(signatureOf([{ kind: "todo", text: "milk" }])).not.toBe(
      signatureOf([{ kind: "heading", text: "milk" }]),
    );
  });
});

describe("matching a tick to a line", () => {
  test("case and surrounding space do not lose a tick", () => {
    expect(tickKey("  Chicken Broth ")).toBe(tickKey("chicken broth"));
  });

  test("but two different items stay different", () => {
    expect(tickKey("Chicken broth")).not.toBe(tickKey("Beef broth"));
  });
});

describe("a note that has already been corrupted", () => {
  // Every case here is the same real failure: a paste that added a copy of the
  // note instead of replacing it. The write path now proves it replaced, so
  // this should stop happening — but ten copies were already sitting in a
  // household's note by the time anybody noticed, and a note that cannot repair
  // itself stays wrong until a person edits it by hand.

  test("a second copy of our own block is reclaimed, not preserved forever", () => {
    // The hole this closes: splitting at the FIRST sentinel made the second
    // copy part of "theirs", and "theirs" is copied through verbatim on every
    // single write. The note could never come back from it.
    const note = [...generated("milk"), ...generated("milk", "eggs")];
    const { ours, theirs } = splitOwned(note);
    expect(theirs).toEqual([]);
    expect(ours.filter((b) => b.text === "Kitchen")).toHaveLength(2);
    // Which is the point: `ours` is what the next write replaces outright.
  });

  test("a line of theirs stranded above the last sentinel is put back below it", () => {
    // The cost of reading the last sentinel instead of the first, and the
    // reason it is paid rather than ignored. A bad paste can land in the middle
    // of somebody's own lines, and losing one of those is the worst thing this
    // whole feature can do.
    const note: Block[] = [
      ...generated("milk"),
      { kind: "todo", text: "beer", done: true },
      ...generated("milk", "eggs"),
      { kind: "todo", text: "wine", done: false },
    ];
    const { theirs } = splitOwned(note);
    expect(theirs).toEqual([
      { kind: "todo", text: "beer", done: true },
      { kind: "todo", text: "wine", done: false },
    ]);
  });

  test("but a stranded line already sitting below is not put back twice", () => {
    // Every write copies "theirs" through, so a stranded line usually has a
    // living twin underneath. Keeping both would grow the note by a line on
    // every pass, which is the shape of the bug this file exists for.
    const note: Block[] = [
      ...generated("milk"),
      { kind: "todo", text: "beer", done: false },
      ...generated("milk"),
      { kind: "todo", text: "beer", done: false },
    ];
    expect(splitOwned(note).theirs).toEqual([{ kind: "todo", text: "beer", done: false }]);
  });

  test("the sentinel is still found after its wording changed", () => {
    // A sentinel that stops matching is indistinguishable from one that is
    // missing: the next sync decides the whole note is somebody else's and
    // prepends a second list above it. Every note on every sleeping phone still
    // carries whatever wording it was last written with.
    const note: Block[] = [
      { kind: "title", text: "Kitchen" },
      { kind: "todo", text: "milk", done: false },
      { kind: "text", text: OLD_SENTINEL },
      { kind: "todo", text: "beer", done: false },
    ];
    const { ours, theirs } = splitOwned(note);
    expect(ours.map((b) => b.text)).toEqual(["Kitchen", "milk"]);
    expect(theirs).toEqual([{ kind: "todo", text: "beer", done: false }]);
  });

  test("and an old wording does not count as a change worth rewriting for", () => {
    expect(signatureOf([{ kind: "text", text: OLD_SENTINEL }])).toBe(signatureOf([]));
  });
});

describe("lines they typed on a phone", () => {
  test("a line is adopted whatever the editor styled it as", () => {
    // The rule this replaces was "checklist items only", which would have fixed
    // nothing: the line above the sentinel is plain text, so that is what Notes
    // continues when somebody types under it, and all three lines that started
    // this were plain text.
    expect(
      adoptable([
        { kind: "todo", text: "Sliced mushrooms, 8 oz", done: false },
        { kind: "dash", text: "Tomatoes on the vine", done: false },
        { kind: "text", text: "paper towels, 1 pack" },
      ]),
    ).toEqual([
      { name: "Sliced mushrooms", amount: "8 oz", text: "Sliced mushrooms, 8 oz" },
      { name: "Tomatoes on the vine", amount: null, text: "Tomatoes on the vine" },
      { name: "paper towels", amount: "1 pack", text: "paper towels, 1 pack" },
    ]);
  });

  test("a heading is structure, and a sentence is a note to the household", () => {
    // Nothing you buy is eighty characters long, and "remember to ask Jordan
    // whether he wants to do the grill on Saturday" belongs where it was
    // written rather than between the salsa and the avocados.
    expect(
      adoptable([
        { kind: "heading", text: "party" },
        {
          kind: "text",
          text:
            "remember to ask Jordan whether he wants to do the grill on Saturday, " +
            "and if so what he needs",
        },
      ]),
    ).toEqual([]);
  });

  test("and the timestamp is never mistaken for shopping", () => {
    expect(adoptable([{ kind: "text", text: "Updated Aug 19, 2026 at 8:53 PM." }])).toEqual([]);
  });

  test("two things on one line stay one thing, rather than becoming an amount", () => {
    // The expensive direction to guess wrong in: "Bread, milk" split as a
    // quantity puts bread on the list and silently loses the milk.
    expect(adoptable([{ kind: "todo", text: "Bread, milk", done: false }])).toEqual([
      { name: "Bread, milk", amount: null, text: "Bread, milk" },
    ]);
  });

  test("the same line written twice is adopted once", () => {
    expect(
      adoptable([
        { kind: "todo", text: "beer", done: false },
        { kind: "todo", text: "Beer", done: true },
      ]),
    ).toHaveLength(1);
  });
});

describe("proving the write actually landed", () => {
  const want = generated("milk", "eggs");

  test("the note as written is recognised", () => {
    expect(sameDoc(want, parseAppleHtml(toAppleHtml(want)))).toBe(true);
  });

  test("a paste that appended instead of replacing is caught", () => {
    // The whole reason this function exists. From every angle the browser can
    // see, this write succeeded.
    expect(sameDoc(want, [...want, ...want])).toBe(false);
  });

  test("so is a paste that only half landed", () => {
    expect(sameDoc(want, want.slice(0, 3))).toBe(false);
  });

  test("a curly apostrophe is not a failed write", () => {
    // Editors are entitled to substitute these, and retrying forever over one
    // would be its own outage.
    const mine: Block[] = [{ kind: "title", text: "Alex's list" }];
    expect(sameDoc(mine, [{ kind: "title", text: "Alex\u2019s list" }])).toBe(true);
  });

  test("but losing the checkboxes is", () => {
    // Word for word identical and completely useless: a list nobody can tick.
    const flat = want.map((b): Block => ({ kind: "text", text: b.text }));
    expect(sameDoc(want, flat)).toBe(false);
  });
});

/**
 * The complaint that started this: a line typed INTO the list, not below it.
 *
 * The sentinel asks people to add at the bottom, and people add at the top,
 * because that is where the list is. Everything above the sentinel used to be
 * classified as ours wholesale, so her line was neither adopted nor carried
 * through — the next write simply rebuilt the block from the ledger and it was
 * gone, leaving no trace in the note, the list or the log.
 */
describe("a line typed inside our own block", () => {
  const ourLines = new Set(["chicken broth", "avocados"].map(tickKey));
  const note: Block[] = [
    { kind: "title", text: "Kitchen" },
    { kind: "heading", text: "Out of something you keep" },
    { kind: "todo", text: "Chicken broth", done: false },
    { kind: "todo", text: "Dish soap", done: false },
    { kind: "todo", text: "Avocados", done: false },
    { kind: "text", text: SENTINEL },
  ];

  test("is rescued instead of overwritten", () => {
    expect(splitOwned(note, ourLines).theirs).toEqual([
      { kind: "todo", text: "Dish soap", done: false },
    ]);
  });

  test("and reaches the real list", () => {
    expect(adoptable(splitOwned(note, ourLines).theirs).map((a) => a.name)).toEqual(["Dish soap"]);
  });

  test("while the lines we generated stay ours", () => {
    expect(splitOwned(note, ourLines).ours.map((b) => b.text)).toEqual([
      "Kitchen",
      "Out of something you keep",
      "Chicken broth",
      "Avocados",
    ]);
  });

  test("and a heading is structure, never shopping", () => {
    expect(
      adoptable(splitOwned(note, ourLines).theirs).some(
        (a) => a.name === "Out of something you keep",
      ),
    ).toBe(false);
  });

  // The guard that stops this shipping as a catastrophe. Before the first write
  // under the new code there is no record of what we generated, and reading an
  // empty set as "we generated nothing" would strand the whole block and adopt
  // every staple as a hand-written line.
  test("no record of a previous write means the old behaviour, not an empty one", () => {
    expect(splitOwned(note, new Set()).theirs).toEqual([]);
    expect(splitOwned(note).theirs).toEqual([]);
  });
});
