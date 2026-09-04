import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_KEEP_RECENT, personArchivableSections } from "../src/persona/archive.ts";
import { renderPrinciples } from "../src/persona/principles.ts";

/**
 * The three mechanisms that touch a person file have to agree with each other.
 *
 *   maintainer   appends observations
 *   consolidator distils them into rules
 *   archiver     moves aged observations out of the always-injected live file
 *
 * They were independent, and two of the couplings were wrong. Archiving ran
 * BEFORE consolidation, so the consolidator was handed a file the archiver had
 * already thinned — deriving the rules for a person from a view with that
 * person's history removed. And "Our Dynamic" was permanently exempt from
 * archiving while being the one section principles most directly replace, so
 * the same knowledge was carried twice on every turn.
 */

describe("archiving is coupled to consolidation", () => {
  const observations = ["## Our Dynamic", "- **2026-08-01** — he pings until answered"].join("\n");

  test("Our Dynamic stays live until principles exist to carry it", () => {
    const sections = personArchivableSections(observations);
    expect(sections.has("Our Dynamic")).toBeFalse();
    // The retrospective sections are archivable regardless.
    expect(sections.has("Shared History")).toBeTrue();
  });

  test("once principles exist, Our Dynamic becomes archivable", () => {
    const withRules = `${renderPrinciples(
      [{ rule: "His own cut ships — give the note, skip the recut.", evidence: ["2026-08-18"] }],
      20,
    )}\n${observations}`;
    expect(personArchivableSections(withRules).has("Our Dynamic")).toBeTrue();
  });

  test("Who They Are is never archivable — identity is not a behavioural rule", () => {
    const withRules = `${renderPrinciples([{ rule: "some standing rule", evidence: [] }], 20)}\n${observations}`;
    expect(personArchivableSections(withRules).has("Who They Are")).toBeFalse();
    expect(personArchivableSections(observations).has("Who They Are")).toBeFalse();
  });

  test("Open Items keeps a deep tail — those are live commitments, not history", () => {
    expect(SECTION_KEEP_RECENT.get("Open Items")).toBeGreaterThanOrEqual(40);
    expect(SECTION_KEEP_RECENT.get("Our Dynamic")).toBeLessThan(15);
  });
});

describe("maintenance ordering", () => {
  test("consolidation runs BEFORE the archive sweep", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/persona/maintainer.ts"), "utf8");
    const consolidate = src.indexOf("consolidatePerson(handle");
    const archive = src.indexOf("archivePersonFile(");
    expect(consolidate).toBeGreaterThan(-1);
    expect(archive).toBeGreaterThan(-1);
    // If this inverts, the consolidator derives rules from a file the archiver
    // has already thinned, and the person's own history is missing from it.
    expect(consolidate).toBeLessThan(archive);
  });

  test("the archive sweep is told which sections the file's principles permit", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/persona/maintainer.ts"), "utf8");
    expect(src).toContain("personArchivableSections(body)");
  });
});
