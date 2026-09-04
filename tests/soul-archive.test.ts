import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSelfFile } from "../src/persona/archive.ts";

/**
 * SOUL.md is injected into EVERY turn of EVERY conversation, so a token here
 * is spent everywhere. Its "Other durable context" section had reached 20,567
 * tokens — 90 bullets averaging 940 chars — roughly half the entire system
 * prompt, describing project detail from months earlier.
 *
 * It was never archived for a reason that reads as a typo: the sweep matched
 * sections with `^##\s+`, which cannot match a `###` heading (it consumes two
 * hashes and then wants whitespace where the third is). Every `###`
 * subsection was invisible, and the size gate reported nothing to do.
 */

function soulWith(bullets: number): string {
  const lines = [
    "# SOUL",
    "",
    "## Your evolving character",
    "",
    "### Other durable context",
    "*(Project context, dates that matter.)*",
    "",
  ];
  for (let i = 0; i < bullets; i++) {
    const day = String((i % 27) + 1).padStart(2, "0");
    lines.push(`- **2026-06-${day}** — durable fact number ${i} ${"x".repeat(400)}`);
  }
  lines.push("", "## About Alex (operator)", "", "- Curated, never archived.");
  return lines.join("\n");
}

describe("SOUL.md archiving", () => {
  test("### subsections are archivable — the regex bug that hid 20k tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    try {
      writeFileSync(join(dir, "SOUL.md"), soulWith(60));
      const before = readFileSync(join(dir, "SOUL.md"), "utf8").length;
      const res = archiveSelfFile("SOUL.md", dir);
      const after = readFileSync(join(dir, "SOUL.md"), "utf8");

      expect(res).not.toBeNull();
      expect(res!.moved).toBeGreaterThan(0);
      expect(after.length).toBeLessThan(before);
      // Nothing is deleted — the archive holds what moved.
      const archived = readFileSync(join(dir, "archive", "SOUL.md"), "utf8");
      expect(archived).toContain("durable fact number 0");
      // The live file keeps a pointer so the model knows more exists.
      expect(after).toMatch(/older entries archived/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("curated sections are never archived", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    try {
      writeFileSync(join(dir, "SOUL.md"), soulWith(60));
      archiveSelfFile("SOUL.md", dir);
      const after = readFileSync(join(dir, "SOUL.md"), "utf8");
      expect(after).toContain("Curated, never archived.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the most recent bullets stay in the live file", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    try {
      writeFileSync(join(dir, "SOUL.md"), soulWith(60));
      archiveSelfFile("SOUL.md", dir);
      const after = readFileSync(join(dir, "SOUL.md"), "utf8");
      // Newest dates survive; the sweep is oldest-first.
      expect(after).toContain("2026-06-27");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("archived self-notes stay reachable", () => {
  test("the indexer indexes SOUL globally, and recall excludes only the live copy", () => {
    const indexer = readFileSync(join(import.meta.dir, "..", "src/memory/indexer.ts"), "utf8");
    // Indexed at all — before this, nothing read SOUL.md into recall, so
    // archiving it would have moved 63 bullets somewhere unreadable.
    expect(indexer).toContain("indexSelfFiles");
    expect(indexer).toContain('kind: "self-file"');
    // Null chat guid: SOUL is true in every conversation, not one of them.
    expect(indexer).toMatch(/kind: "self-file" as const,\s*\n\s*chatGuid: null/);

    const recall = readFileSync(join(import.meta.dir, "..", "src/memory/auto-recall.ts"), "utf8");
    // A global pass, because the chat-scoped blocks can never see a null guid.
    expect(recall).toContain('scope: { kind: "global" }');
    expect(recall).toContain('rowKinds: ["self-file"]');
    // The LIVE file is already in the prompt; only the archive is worth recalling.
    expect(recall).toContain('ref.startsWith("self:") && !ref.startsWith("self:archive/")');
  });
});
