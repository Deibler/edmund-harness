/**
 * The line-level note writer, minus the browser.
 *
 * What is pinned here is everything that decides WHICH lines get touched. The
 * failure it exists to prevent is quiet: a whole-body write looks identical on
 * the web and only shows up days later as stacked copies on somebody's phone.
 * So the tests are about restraint — an unchanged title is never in a hunk, an
 * unchanged line is never in a hunk, and a note the caret cannot be steered
 * through is refused rather than guessed at.
 */

import { describe, expect, test } from "bun:test";
import { type Block, toAppleHtml } from "../src/notedoc.ts";
import { carryTicks, diffParas, paragraphs, sameOrder } from "../src/notepatch.ts";

const title: Block = { kind: "title", text: "Kitchen list" };
const heading: Block = { kind: "heading", text: "Out of something you keep" };
const todo = (text: string, done = false): Block => ({ kind: "todo", text, done });
const text = (t: string): Block => ({ kind: "text", text: t });
const plain = (bs: Block[]) => bs.map((b) => `${b.text}\n`).join("");

/** Replay hunks on a line array, the way the editor applies them bottom-up. */
function apply(cur: Block[], want: Block[]): Block[] {
  const out = [...cur];
  for (const h of [...diffParas(cur, want)].reverse()) out.splice(h.at, h.remove, ...h.insert);
  return out;
}

describe("diffParas", () => {
  const base = [title, heading, todo("Eggs"), todo("Milk"), text("Updated Sep 23."), text("tail")];

  test("an identical note has nothing to do", () => {
    expect(diffParas(base, base)).toEqual([]);
  });

  test("a changed footer touches only the footer", () => {
    const want = base.map((b) => (b.text.startsWith("Updated") ? text("Updated Sep 24.") : b));
    expect(diffParas(base, want)).toEqual([
      { at: 4, remove: 1, insert: [text("Updated Sep 24.")] },
    ]);
  });

  test("the title is never part of a hunk when it has not changed", () => {
    const want = [
      title,
      heading,
      todo("Bread"),
      todo("Milk"),
      text("Updated Sep 24."),
      text("tail"),
    ];
    for (const h of diffParas(base, want)) expect(h.at).toBeGreaterThan(0);
    expect(apply(base, want)).toEqual(want);
  });

  test("an added item is an insert, not a rewrite of what follows", () => {
    const want = [
      title,
      heading,
      todo("Eggs"),
      todo("Butter"),
      todo("Milk"),
      text("Updated Sep 23."),
      text("tail"),
    ];
    expect(diffParas(base, want)).toEqual([{ at: 3, remove: 0, insert: [todo("Butter")] }]);
  });

  test("a removed item is a delete of that line alone", () => {
    const want = [title, heading, todo("Milk"), text("Updated Sep 23."), text("tail")];
    expect(diffParas(base, want)).toEqual([{ at: 2, remove: 1, insert: [] }]);
  });

  test("a tick is a change to that line", () => {
    const want = base.map((b) => (b.text === "Milk" ? todo("Milk", true) : b));
    expect(diffParas(base, want)).toEqual([{ at: 3, remove: 1, insert: [todo("Milk", true)] }]);
  });

  test("appending after the last line inserts at the end", () => {
    const want = [...base, text("more")];
    expect(diffParas(base, want)).toEqual([{ at: 6, remove: 0, insert: [text("more")] }]);
  });

  test("a stacked copy of the list is removed and the original kept", () => {
    const stacked = [title, ...base.slice(1), title, ...base.slice(1)];
    const hunks = diffParas(stacked, base);
    expect(hunks.reduce((n, h) => n + h.remove, 0)).toBe(base.length);
    expect(hunks.every((h) => h.insert.length === 0)).toBe(true);
    expect(apply(stacked, base)).toEqual(base);
  });

  test("stray blank paragraphs are removed in passing", () => {
    const cur = [title, null, heading, todo("Eggs")];
    expect(diffParas(cur, [title, heading, todo("Eggs")])).toEqual([
      { at: 1, remove: 1, insert: [] },
    ]);
  });

  test("hunks replay to exactly the wanted document on shuffled edits", () => {
    const want = [
      title,
      text("Nothing is out."),
      text("Updated Sep 25."),
      text("tail"),
      text("new"),
    ];
    expect(apply(base, want)).toEqual(want);
  });
});

describe("paragraphs", () => {
  const doc = [title, heading, todo("Eggs"), todo("Milk", true), text("Updated Sep 23.")];

  test("reads one paragraph per line with its kind", () => {
    const ps = paragraphs(toAppleHtml(doc), plain(doc));
    expect(ps?.map((p) => p.raw)).toEqual(doc.map((b) => b.text));
    expect(ps?.map((p) => p.block)).toEqual(doc);
  });

  test("an empty note is no paragraphs", () => {
    expect(paragraphs("", "")).toEqual([]);
  });

  test("refuses when the plain text has a line the HTML does not", () => {
    expect(paragraphs(toAppleHtml(doc), `${plain(doc)}extra\n`)).toBeNull();
  });

  test("refuses when a line's text differs between the two views", () => {
    const off = plain(doc).replace("Eggs", "Eggs\uFFFC");
    expect(paragraphs(toAppleHtml(doc), off)).toBeNull();
  });

  test("refuses a note whose last line has no line break", () => {
    expect(paragraphs(toAppleHtml(doc), plain(doc).slice(0, -1))).toBeNull();
  });
});

describe("carryTicks", () => {
  test("the freshest read's tick wins over the one the list was built from", () => {
    const want = [title, todo("Eggs"), todo("Milk", true)];
    const fresh = [title, todo("Eggs", true), todo("Milk", false)];
    expect(carryTicks(want, fresh)).toEqual([title, todo("Eggs", true), todo("Milk", false)]);
  });

  test("a line the note does not have keeps its own state", () => {
    expect(carryTicks([todo("Bread", false)], [todo("Eggs", true)])).toEqual([
      todo("Bread", false),
    ]);
  });
});

describe("sameOrder", () => {
  const doc = [title, todo("Eggs"), text("tail")];

  test("accepts the same lines in the same order", () => {
    expect(sameOrder(doc, [...doc])).toBe(true);
  });

  test("rejects a stacked copy that a multiset check would also catch", () => {
    expect(sameOrder(doc, [...doc, ...doc])).toBe(false);
  });

  test("rejects the right lines in the wrong order", () => {
    expect(sameOrder(doc, [title, text("tail"), todo("Eggs")])).toBe(false);
  });

  test("rejects a tick that did not land", () => {
    expect(sameOrder([todo("Eggs", true)], [todo("Eggs", false)])).toBe(false);
  });

  test("allows the editor's typographic quotes", () => {
    expect(sameOrder([todo("Mom's milk")], [todo("Mom\u2019s milk")])).toBe(true);
  });
});
