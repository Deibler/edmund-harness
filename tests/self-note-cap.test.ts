import { describe, expect, test } from "bun:test";
import { MAX_SELF_NOTE_CHARS } from "../src/persona/self-memory.ts";

/**
 * A self-note is the most expensive text in the system: SOUL.md is injected
 * into every turn of every conversation, so it is re-read forever. The
 * existing entries averaged 940 characters and ran to 2,196 — reasoning, not
 * facts — and 90 of them became half the system prompt.
 */
describe("self-note cap", () => {
  test("the cap is small enough to have caught the entries that caused this", () => {
    // Median existing entry was 940 chars; the cap must be well under it.
    expect(MAX_SELF_NOTE_CHARS).toBeLessThan(940);
    // ...but still room for a real fact rather than a fragment.
    expect(MAX_SELF_NOTE_CHARS).toBeGreaterThanOrEqual(300);
  });

  test("an over-long note is refused with guidance, not silently truncated", async () => {
    const { appendSelfNote } = await import("../src/persona/self-memory.ts");
    expect(() =>
      appendSelfNote({ section: "other", note: "x".repeat(MAX_SELF_NOTE_CHARS + 1) }),
    ).toThrow(/cap is/);
  });

  test("a date the model wrote itself is not doubled", async () => {
    const src = await Bun.file(
      new URL("../src/persona/self-memory.ts", import.meta.url).pathname,
    ).text();
    // Every existing bullet reads `- **2026-08-10** — 2026-08-10 — …`.
    expect(src).toContain("stripLeadingDate");
  });
});
