/**
 * Tests for the speaker-tagged history formatter and the inline
 * `--- Xm gap ---` markers it injects at topic-shift indices.
 */
import { describe, expect, test } from "bun:test";
import { formatHistoryLines } from "../src/channels/history-format.ts";
import type { HistoryLine } from "../src/imessage/history.ts";
import { AddressBook } from "../src/sessions/address-book.ts";
import { ContactBook } from "../src/sessions/contacts.ts";

function line(rowId: number, ms: number, who: string, text: string, fromMe = false): HistoryLine {
  return { rowId, timestampMs: ms, fromHandle: who, fromMe, text };
}

function bookFor(entries: Array<{ name: string; handles: string[] }>): ContactBook {
  return new ContactBook(entries, new AddressBook());
}

describe("formatHistoryLines", () => {
  test("speaker-tags every line with [Name · Day HH:MM]", () => {
    const contacts = bookFor([
      { name: "Jordan", handles: ["+15551110001"] },
      { name: "Riley", handles: ["+15551110002"] },
    ]);
    // Fixed UTC ms for reproducibility — the rendered hour depends on TZ,
    // so we assert on the structural pieces rather than exact times.
    const t = Date.parse("2026-05-13T18:00:00Z");
    const lines = [
      line(1, t, "+15551110001", "hey edmund"),
      line(2, t + 60_000, "+15551110002", "lol"),
      line(3, t + 120_000, "me", "hi everyone", true),
    ];
    const out = formatHistoryLines(lines, contacts);
    expect(out.length).toBe(3);
    expect(out[0]).toMatch(/\[Jordan · \w{3} \d{2}:\d{2}\] hey edmund$/);
    expect(out[1]).toMatch(/\[Riley · \w{3} \d{2}:\d{2}\] lol$/);
    expect(out[2]).toMatch(/\[You · \w{3} \d{2}:\d{2}\] hi everyone$/);
  });

  test("falls back to raw handle when ContactBook has no name", () => {
    const contacts = bookFor([]);
    const t = Date.parse("2026-05-13T18:00:00Z");
    const out = formatHistoryLines([line(1, t, "+15559998888", "yo")], contacts);
    expect(out[0]).toContain("[+15559998888 · ");
  });

  test("injects a --- Xm gap --- marker before each topic-shift index", () => {
    const contacts = bookFor([{ name: "Jordan", handles: ["+15551110001"] }]);
    const t = Date.parse("2026-05-13T18:00:00Z");
    const lines = [
      line(1, t, "+15551110001", "first"),
      line(2, t + 60_000, "+15551110001", "second"),
      line(3, t + 60_000 + 8 * 60_000, "+15551110001", "third"), // 8m gap
    ];
    const out = formatHistoryLines(lines, contacts, [2]);
    // Output: line0, line1, MARKER, line2 → 4 entries
    expect(out.length).toBe(4);
    expect(out[0]).toContain("first");
    expect(out[1]).toContain("second");
    expect(out[2]).toBe("  --- 8m gap ---");
    expect(out[3]).toContain("third");
  });

  test("a topic-shift at index 0 is ignored (no preceding line to gap from)", () => {
    const contacts = bookFor([{ name: "Jordan", handles: ["+15551110001"] }]);
    const t = Date.parse("2026-05-13T18:00:00Z");
    const lines = [
      line(1, t, "+15551110001", "first"),
      line(2, t + 60_000, "+15551110001", "second"),
    ];
    const out = formatHistoryLines(lines, contacts, [0]);
    expect(out.length).toBe(2);
    expect(out[0]).toContain("first");
    expect(out[1]).toContain("second");
  });
});
