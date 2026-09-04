import { describe, expect, test } from "bun:test";
import {
  billableLength,
  chunkForSms,
  encodingFor,
  isGsm7,
  segmentCount,
  toGsm7,
} from "../src/sms/segment.ts";

describe("sms encoding detection", () => {
  test("plain ASCII is GSM-7", () => {
    expect(isGsm7("Hey, it's Edmund. Running late.")).toBe(true);
    expect(encodingFor("Hey")).toBe("GSM-7");
  });

  test("a curly apostrophe forces UCS-2", () => {
    // The whole reason toGsm7 exists: this character is invisible in a diff
    // and triples the cost of a 160-char reply.
    expect(isGsm7("Hey, it’s Edmund")).toBe(false);
    expect(encodingFor("Hey, it’s Edmund")).toBe("UCS-2");
  });

  test("emoji forces UCS-2 and counts two code units", () => {
    expect(isGsm7("nice 😂")).toBe(false);
    expect(billableLength("😂")).toBe(2);
  });
});

describe("billable length", () => {
  test("extended GSM-7 characters cost two septets each", () => {
    expect(billableLength("^")).toBe(2);
    expect(billableLength("{}")).toBe(4);
    expect(billableLength("a")).toBe(1);
  });

  test("160 carets is NOT one segment", () => {
    const body = "^".repeat(160);
    expect(billableLength(body)).toBe(320);
    expect(segmentCount(body)).toBeGreaterThan(1);
  });
});

describe("segment counting", () => {
  test("boundaries for GSM-7", () => {
    expect(segmentCount("")).toBe(0);
    expect(segmentCount("a".repeat(160))).toBe(1);
    expect(segmentCount("a".repeat(161))).toBe(2);
    expect(segmentCount("a".repeat(306))).toBe(2);
    expect(segmentCount("a".repeat(307))).toBe(3);
  });

  test("boundaries for UCS-2", () => {
    // Cyrillic, not accented Latin: "é" is in the GSM-7 basic alphabet and
    // stays single-byte, which is exactly the trap this test exists to avoid.
    const c = "я";
    expect(isGsm7(c)).toBe(false);
    expect(segmentCount(c.repeat(70))).toBe(1);
    expect(segmentCount(c.repeat(71))).toBe(2);
    expect(segmentCount(c.repeat(134))).toBe(2);
    expect(segmentCount(c.repeat(135))).toBe(3);
  });

  test("one curly quote in a 160-char body triples the cost", () => {
    const ascii = "a".repeat(160);
    const curly = `${"a".repeat(159)}’`;
    expect(segmentCount(ascii)).toBe(1);
    expect(segmentCount(curly)).toBe(3);
  });
});

describe("toGsm7", () => {
  test("normalizes smart punctuation without changing meaning", () => {
    const out = toGsm7("It’s “fine” — really…");
    expect(out).toBe('It\'s "fine" - really...');
    expect(isGsm7(out)).toBe(true);
  });

  test("leaves genuinely non-Latin text alone rather than mangling a name", () => {
    const name = "Zoë 北京";
    expect(toGsm7(name)).toBe(name);
    expect(isGsm7(toGsm7(name))).toBe(false);
  });
});

describe("chunkForSms", () => {
  test("a short reply is one chunk, unchanged", () => {
    expect(chunkForSms("on it")).toEqual(["on it"]);
  });

  test("empty input produces no messages", () => {
    expect(chunkForSms("   ")).toEqual([]);
  });

  test("respects the segment budget", () => {
    const body = "word ".repeat(400).trim();
    const parts = chunkForSms(body, { maxSegments: 2, maxParts: 6 });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(segmentCount(p)).toBeLessThanOrEqual(2);
  });

  test("does not cut in the middle of a URL", () => {
    const url =
      "https://maps.apple.com/?address=100%20Crossings%20Blvd%2C%20Elverson%2C%20PA%2019520";
    const body = `${"a".repeat(140)} ${url} tail`;
    const parts = chunkForSms(body, { maxSegments: 1, maxParts: 6 });
    // The URL must survive intact in exactly one part.
    expect(parts.filter((p) => p.includes(url)).length).toBe(1);
  });

  test("drops beyond maxParts rather than sending a flood", () => {
    const body = "word ".repeat(2000).trim();
    const parts = chunkForSms(body, { maxSegments: 1, maxParts: 3 });
    expect(parts.length).toBe(3);
  });

  test("never emits an empty chunk", () => {
    const parts = chunkForSms(`${"a".repeat(500)}\n\n\n${"b".repeat(500)}`, { maxSegments: 1 });
    for (const p of parts) expect(p.length).toBeGreaterThan(0);
  });
});
