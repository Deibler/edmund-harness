import { describe, expect, test } from "bun:test";
import { stripAssocPrefix, tapbackGlyph } from "../src/imessage/reactions.ts";

describe("stripAssocPrefix", () => {
  test("threaded reply prefix p:<n>/", () => {
    expect(stripAssocPrefix("p:0/ABCD-1234")).toBe("ABCD-1234");
    expect(stripAssocPrefix("p:12/ABCD-1234")).toBe("ABCD-1234");
  });
  test("quote prefix bp:", () => {
    expect(stripAssocPrefix("bp:ABCD-1234")).toBe("ABCD-1234");
  });
  test("bare guid passes through", () => {
    expect(stripAssocPrefix("ABCD-1234")).toBe("ABCD-1234");
  });
});

describe("tapbackGlyph", () => {
  test("classic six", () => {
    expect(tapbackGlyph(2000)).toBe("❤️");
    expect(tapbackGlyph(2001)).toBe("👍");
    expect(tapbackGlyph(2002)).toBe("👎");
    expect(tapbackGlyph(2003)).toBe("😂");
    expect(tapbackGlyph(2004)).toBe("‼️");
    expect(tapbackGlyph(2005)).toBe("❓");
  });
  test("custom-emoji reactions fall back to a generic label", () => {
    expect(tapbackGlyph(2006)).toBe("reacted");
    expect(tapbackGlyph(2007)).toBe("reacted");
  });
});
