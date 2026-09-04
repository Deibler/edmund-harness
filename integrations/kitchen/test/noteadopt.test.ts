/**
 * A line somebody typed into the note on their phone, and where it ends up.
 *
 * This is the round trip the browser sits in the middle of, with the browser
 * taken out: read a note, adopt what they wrote below the sentinel, build the
 * note that goes back. The bug it pins is not a crash — those three lines were
 * on a phone in a supermarket and on nothing else. They were carried through
 * every write, and the site, the tools and the trip's cost all behaved as
 * though nobody had asked for them.
 *
 * The second half is the trap that adopting sets: the line is now on the real
 * list AND still written where they typed it, so a naive build renders it
 * twice, once ticked and once not.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only, so it is erased and cannot import the module before KITCHEN_DIR is
// set — which is the difference between a fixture and writing into a real
// household's ledger.
import type { Block } from "../src/notedoc.ts";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-noteadopt-"));
process.env.KITCHEN_DIR = BASE;
mkdirSync(join(BASE, "tenants", "hh"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: {
      hh: {
        name: "Test",
        created: "2026-08-01T00:00:00Z",
        members: ["imessage:dm:+15550000000"],
        note_list: "Kitchen",
      },
    },
  }),
);

const { adoptable, buildDoc, SENTINEL, splitOwned } = await import("../src/notedoc.ts");
const { addToList, readList } = await import("../src/list.ts");

const A = "hh";

/** What `syncNote` does either side of the paste, minus the paste. */
const pass = (note: Block[]) => {
  const adopted = adoptable(splitOwned(note).theirs);
  if (adopted.length) {
    addToList(
      A,
      adopted.map((a) => ({ name: a.name, amount: a.amount, why: "you added this in the note" })),
    );
  }
  return { adopted, doc: buildDoc(A, note) };
};

/**
 * The note as a phone leaves it.
 *
 * The mushrooms are a checklist line somebody ticked in a shop. The paper
 * towels are PLAIN TEXT, which is what typing under the sentinel actually
 * produces, and is the case a checklist-only rule would have missed entirely.
 * The last line is a sentence, and sentences stay where they were written.
 */
const NOTE: Block[] = [
  { kind: "title", text: "Kitchen" },
  { kind: "text", text: "Updated Aug 19, 2026 at 8:47 PM." },
  { kind: "text", text: SENTINEL },
  { kind: "todo", text: "Sliced mushrooms, 8 oz", done: true },
  { kind: "text", text: "paper towels, 1 pack" },
  {
    kind: "text",
    text:
      "remember to ask Jordan whether he wants to do the grill on Saturday, " +
      "and what he needs for it",
  },
];

const PROSE = NOTE[NOTE.length - 1]!.text;

const first = pass(NOTE);

describe("a line added below the sentinel", () => {
  test("reaches the list, instead of only ever existing on the phone", () => {
    expect(first.adopted.map((a) => a.name)).toEqual(["Sliced mushrooms", "paper towels"]);
    expect(readList(A).entries.map((e) => [e.name, e.amount])).toEqual([
      ["Sliced mushrooms", "8 oz"],
      ["paper towels", "1 pack"],
    ]);
  });

  test("and comes back rendered once, not once above and once below", () => {
    const lines = first.doc.blocks.filter((b) => b.text.startsWith("Sliced mushrooms"));
    expect(lines).toHaveLength(1);
  });

  test("above the sentinel, where the list is", () => {
    const at = (t: string) => first.doc.blocks.findIndex((b) => b.text.startsWith(t));
    expect(at("Sliced mushrooms")).toBeLessThan(at(SENTINEL));
  });

  test("still ticked, because they ticked it in a shop", () => {
    // Adoption moves the line. Moving it un-ticked would tell somebody standing
    // in an aisle that they had not picked it up yet.
    const line = first.doc.blocks.find((b) => b.text.startsWith("Sliced mushrooms"));
    expect(line?.done).toBe(true);
  });

  test("and their sentence is left exactly where they wrote it", () => {
    const at = (t: string) => first.doc.blocks.findIndex((b) => b.text === t);
    expect(at(PROSE)).toBeGreaterThan(at(SENTINEL));
  });
});

describe("reading the same note again", () => {
  // The write can fail, and then the next pass reads a note that still has the
  // line sitting below the sentinel. Adopting it a second time must change
  // nothing at all.
  const again = pass(NOTE);

  test("adopts it again without duplicating the list entry", () => {
    expect(readList(A).entries).toHaveLength(2);
  });

  test("and builds the same note", () => {
    expect(again.doc.signature).toBe(first.doc.signature);
  });
});
