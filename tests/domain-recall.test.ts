import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLiveProfileChunk } from "../src/memory/auto-recall.ts";
import { appendDomainNote, lessonForRecall } from "../src/persona/domains.ts";

describe("lessons Edmund wrote reach a conversation", () => {
  test("domain notes and the SOUL archive are recallable; the live SOUL is not", () => {
    expect(isLiveProfileChunk("self:domains/video-editing.md#0")).toBe(false);
    expect(isLiveProfileChunk("self:archive/SOUL.md#4")).toBe(false);
    expect(isLiveProfileChunk("self:SOUL.md#2")).toBe(true);
  });

  test("live person and group files stay out (they are in the prompt already)", () => {
    expect(isLiveProfileChunk("person:15555550101.md#1")).toBe(true);
    expect(isLiveProfileChunk("group:chat1.md#0")).toBe(true);
    expect(isLiveProfileChunk("person:archive/15555550101.md#1")).toBe(false);
  });
});

describe("a lesson is about the subject, not the person", () => {
  const file = [
    "# video editing",
    "",
    "### Long videos over 15 MB arrive blurry",
    "- **When it applies:** sending a video longer than a minute over iMessage",
    "- **What I learned:** iMessage recompresses anything large; keep it under 15 MB.",
    "- **Outcome:** WORKED — Pat's study videos, 2026-10-06",
    "- **Recorded:** 2026-10-06",
    "",
    "### Another",
    "- **Outcome:** REJECTED",
  ].join("\n");

  test("recall indexes the lesson without who it came from", () => {
    const out = lessonForRecall(file);
    expect(out).not.toContain("Pat");
    expect(out).toContain("- **Outcome:** WORKED\n");
    expect(out).toContain("keep it under 15 MB");
    expect(out).toContain("- **Outcome:** REJECTED");
  });

  test("phone numbers and emails are refused before anything is written", () => {
    const base = {
      domain: "video editing",
      title: "Keep long videos under 15 MB",
      applies: "iMessage video sends",
      learned: "Anything larger is recompressed and arrives blurry.",
      outcome: "worked" as const,
    };
    expect(() => appendDomainNote({ ...base, source: "+1 555 555 0101" })).toThrow(/by role/);
    expect(() => appendDomainNote({ ...base, learned: "ask pat@example.com first" })).toThrow(
      /by role/,
    );
  });

  test("the indexer reads domain files through the redaction, once re-indexed", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/memory/indexer.ts"), "utf8");
    expect(src).toContain('f.name.startsWith("domains/") ? lessonForRecall(raw) : raw');
    expect(src).toContain('"self.domains.sources_stripped"');
  });
});
