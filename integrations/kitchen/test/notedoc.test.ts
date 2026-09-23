/**
 * The note as a document: the pure part of the Notes sync.
 *
 * The failures pinned here are quiet ones: dropping a line somebody typed, un-ticking
 * something ticked in a shop, and rewriting the note on every pass because the
 * fingerprint includes a clock.
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
    // Ticks must survive the round trip, or a sync un-ticks items mid-shop.
    const parsed = parseAppleHtml(APPLE_HTML);
    expect(ticksIn(parsed).get(tickKey("Avocados"))).toBe(true);
    expect(ticksIn(parsed).get(tickKey("Chicken broth"))).toBe(false);
  });

  test("apostrophes and ampersands come back as themselves", () => {
    // Escaped on the way out, decoded on the way back.
    const blocks: Block[] = [{ kind: "todo", text: "Alex's M&M's <big>", done: false }];
    expect(parseAppleHtml(toAppleHtml(blocks))).toEqual(blocks);
  });

  test("every line ends in a newline inside its span", () => {
    // Without it the editor merges consecutive paragraphs into one line.
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
    // The editor inserts blank spacing paragraphs; keeping them would add a line on
    // every rewrite.
    const withBlank =
      '<meta charset="utf-8">' +
      '<p><span data-tt="{&quot;paragraphStyle&quot;:{}}" style="white-space: pre-wrap;">\n</span></p>' +
      '<p><span data-tt="{&quot;paragraphStyle&quot;:{}}" style="white-space: pre-wrap;">real\n</span></p>';
    expect(parseAppleHtml(withBlank)).toEqual([{ kind: "text", text: "real" }]);
  });

  test("an unreadable style becomes text instead of vanishing", () => {
    // Below the sentinel is the household's own writing; an unknown paragraph style
    // must not drop a line.
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
    // Adopting an existing shared note: their list goes below the generated block,
    // never replaced by it.
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
    // Notes strips HTML comments, so the sentinel is visible text. Three rounds,
    // since a duplication bug often survives one.
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
    // An unchanged list must produce an unchanged fingerprint, or the watch pass
    // rewrites the note every ten seconds.
    const a: Block[] = [{ kind: "text", text: "Updated Aug 17, 2026 at 1:23 PM." }];
    const b: Block[] = [{ kind: "text", text: "Updated Aug 17, 2026 at 9:99 PM." }];
    expect(signatureOf(a)).toBe(signatureOf(b));
  });

  test("neither does ticking something off", () => {
    // A tick is somebody shopping, not a list change; treating it as one would
    // trigger a rewrite that erases it.
    const before: Block[] = [{ kind: "todo", text: "milk", done: false }];
    const after: Block[] = [{ kind: "todo", text: "milk", done: true }];
    expect(signatureOf(before)).toBe(signatureOf(after));
  });

  test("a note read back from what we wrote reports no change", () => {
    // The note as read carries the sentinel and timestamp and the built block does
    // not, so the fingerprint must compare like with like.
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
  // A paste that added a copy instead of replacing leaves stacked copies; the note
  // must be able to repair itself on the next write.

  test("a second copy of our own block is reclaimed, not preserved forever", () => {
    // Splitting at the first sentinel would make the second copy part of "theirs",
    // which every write copies through, so the note could never recover.
    const note = [...generated("milk"), ...generated("milk", "eggs")];
    const { ours, theirs } = splitOwned(note);
    expect(theirs).toEqual([]);
    expect(ours.filter((b) => b.text === "Kitchen")).toHaveLength(2);
    // `ours` is what the next write replaces outright.
  });

  test("a line of theirs stranded above the last sentinel is put back below it", () => {
    // The cost of splitting at the last sentinel: a bad paste can strand the
    // household's own lines inside our block, and those must be rescued.
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
    // A stranded line usually has a twin below the sentinel; keeping both would grow
    // the note on every pass.
    const note: Block[] = [
      ...generated("milk"),
      { kind: "todo", text: "beer", done: false },
      ...generated("milk"),
      { kind: "todo", text: "beer", done: false },
    ];
    expect(splitOwned(note).theirs).toEqual([{ kind: "todo", text: "beer", done: false }]);
  });

  test("the sentinel is still found after its wording changed", () => {
    // Old sentinel wordings must keep matching: a note on a sleeping phone still
    // carries whatever it was last written with, and an unmatched sentinel makes the
    // sync prepend a second list.
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
    // Typing under a plain-text line produces plain text, so adoption cannot be
    // limited to checklist items.
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
    // A long sentence is a note to somebody, not a shopping line, and stays where it
    // was written.
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
    // Guessing a quantity wrongly here would lose an item: "Bread, milk" is two
    // lines, not bread with an amount.
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
    // The write reported success; only comparing the read-back reveals the extra
    // copy.
    expect(sameDoc(want, [...want, ...want])).toBe(false);
  });

  test("so is a paste that only half landed", () => {
    expect(sameDoc(want, want.slice(0, 3))).toBe(false);
  });

  test("a curly apostrophe is not a failed write", () => {
    // Typographic substitutions by the editor must not fail the comparison forever.
    const mine: Block[] = [{ kind: "title", text: "Alex's list" }];
    expect(sameDoc(mine, [{ kind: "title", text: "Alex\u2019s list" }])).toBe(true);
  });

  test("but losing the checkboxes is", () => {
    // Identical words as plain text instead of checkboxes is still a failed write.
    const flat = want.map((b): Block => ({ kind: "text", text: b.text }));
    expect(sameDoc(want, flat)).toBe(false);
  });
});

/**
 * A line typed inside the generated block, not below the sentinel, must be rescued.
 * Everything above the sentinel used to be treated as ours, so such a line vanished
 * on the next write.
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
