/**
 * Lines typed into the shared note below the sentinel are adopted onto the real
 * list, and the rebuilt note shows each such line once, with its tick kept.
 * Adoption is idempotent, since a failed write means the next pass reads the
 * same lines again.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Type-only import: erased at runtime, so nothing loads before KITCHEN_DIR is set.
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
 * The note as a phone leaves it: a ticked checklist line, a plain-text line
 * (what typing below the sentinel produces), and a sentence, which stays put.
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
    // The tick moves with the adopted line.
    const line = first.doc.blocks.find((b) => b.text.startsWith("Sliced mushrooms"));
    expect(line?.done).toBe(true);
  });

  test("and their sentence is left exactly where they wrote it", () => {
    const at = (t: string) => first.doc.blocks.findIndex((b) => b.text === t);
    expect(at(PROSE)).toBeGreaterThan(at(SENTINEL));
  });
});

describe("reading the same note again", () => {
  // After a failed write the line is still below the sentinel; adopting it
  // again must change nothing.
  const again = pass(NOTE);

  test("adopts it again without duplicating the list entry", () => {
    expect(readList(A).entries).toHaveLength(2);
  });

  test("and builds the same note", () => {
    expect(again.doc.signature).toBe(first.doc.signature);
  });
});
