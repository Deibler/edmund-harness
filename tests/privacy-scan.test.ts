import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactBook } from "../src/sessions/contacts.ts";
import { collectKnownNames, findLeaks } from "../src/skills/privacy.ts";

/**
 * The leak scanner.
 *
 * It guards everything that leaves a conversation — curated skills, published
 * skills, announcements — so it fails CLOSED: an ambiguous token is treated as
 * a name, and an incomplete stoplist makes it stricter rather than laxer.
 *
 * It has been wrong in both directions and both are tested here. It once
 * iterated only `[[contacts]]` (one entry in this deployment) and passed text
 * that plainly named people. Fixing that by pulling in GROUP titles then made
 * "the", "chat" and "house" into names, which flagged 20 of 23 shipped skills
 * — and a check that fires on everything is the same as one that fires on
 * nothing.
 */

let PERSONA: string;

beforeAll(() => {
  // Built here rather than assumed on disk: a fixture the test does not
  // create is a test that passes only on the machine that made it.
  PERSONA = mkdtempSync(join(tmpdir(), "persona-"));
  mkdirSync(join(PERSONA, "people"), { recursive: true });
  mkdirSync(join(PERSONA, "groups"), { recursive: true });
  writeFileSync(join(PERSONA, "people", "a.md"), "# Jon Fox\n\n- Phone: +15550009999\n");
  writeFileSync(join(PERSONA, "people", "b.md"), "# +15550008888\n\n- Handle: +15550008888\n");
  writeFileSync(join(PERSONA, "groups", "house.md"), "# The House Chat\n\n- members\n");
});

afterAll(() => rmSync(PERSONA, { recursive: true, force: true }));

const contacts = new ContactBook([{ name: "Dana Whitfield", handles: ["+15550001111"] }]);
const scan = (text: string, allow: string[] = []) =>
  findLeaks(text, contacts, allow, { personaDir: PERSONA });

describe("the roster", () => {
  test("includes names from person files, not just config contacts", () => {
    // The bug that made this check nearly a no-op: config holds a handful of
    // people, the person files hold everyone Edmund actually talks to.
    const names = collectKnownNames(contacts, PERSONA);
    expect(names).toContain("Dana Whitfield");
    expect(names).toContain("Jon Fox");
  });

  test("excludes group titles — a room name is not a person's name", () => {
    expect(collectKnownNames(contacts, PERSONA)).not.toContain("The House Chat");
  });

  test("skips person files titled with a bare handle", () => {
    expect(collectKnownNames(contacts, PERSONA).some((n) => n.includes("5550008888"))).toBe(false);
  });
});

describe("what it catches", () => {
  test("a name from a person file, in ordinary prose", () => {
    expect(scan("Ask Whitfield how they usually do it").map((f) => f.detail)).toContain(
      "Whitfield",
    );
  });

  test("a three-letter name — the old length cutoff exempted these", () => {
    expect(scan("check with Jon first").map((f) => f.detail)).toContain("Jon");
  });

  test("lowercase names, the way people actually text", () => {
    expect(scan("ask dana about it").length).toBeGreaterThan(0);
  });

  test("a possessive", () => {
    expect(scan("use Dana's version").map((f) => f.detail)).toContain("Dana");
  });

  test("accents folded — José and Jose are one person", () => {
    const withAccent = new ContactBook([{ name: "José Álvarez", handles: ["+15550002222"] }]);
    expect(findLeaks("ask Jose about it", withAccent).length).toBeGreaterThan(0);
  });

  test("phones, emails, social handles and street addresses", () => {
    const kinds = (t: string) => scan(t).map((f) => f.kind);
    expect(kinds("call 717-555-0134")).toContain("phone");
    expect(kinds("email someone@example.com")).toContain("email");
    expect(kinds("find them @somebody")).toContain("handle");
    expect(kinds("meet at 910 N 27th St")).toContain("address");
  });
});

describe("what it must not catch", () => {
  test("ordinary technical prose stays clean", () => {
    const prose = [
      "Read the chat history for the group, then summarise it for the team.",
      "Work at home is fine; the house style is no emojis.",
      "Ask the family what they want for dinner and check the fridge first.",
    ].join("\n");
    expect(scan(prose)).toEqual([]);
  });

  test("a name that is also a common word only trips when capitalised", () => {
    // "a hunter" is not a person; "Hunter" probably is. Without this the
    // scanner fires on max, will, grace, page and rose in normal writing.
    const book = new ContactBook([{ name: "Hunter Grace", handles: ["+15550003333"] }]);
    expect(findLeaks("set max offers and give it grace to finish", book)).toEqual([]);
    expect(findLeaks("ask Hunter about it", book).length).toBeGreaterThan(0);
  });

  test("a name inside a longer word is not a match", () => {
    expect(scan("the marathon danced along")).toEqual([]);
  });

  test("the author's own name is allowed through", () => {
    expect(scan("Dana wrote this one", ["Dana"]).map((f) => f.detail)).not.toContain("Dana");
  });

  test("a year range is not a phone number", () => {
    expect(scan("covering 2019-2024 and 2025").map((f) => f.kind)).not.toContain("phone");
  });
});
