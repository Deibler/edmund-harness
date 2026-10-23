import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config/config.ts";
import {
  ARCHIVE_TARGET_BYTES,
  ARCHIVE_TRIGGER_BYTES,
  MIN_RECENT_BULLETS,
  NOTE_BYTES,
  SECTION_KEEP_RECENT,
  archiveGroupFile,
  archivePathFor,
  archivePersonFile,
  archiveRewriteDrops,
  archivedObservationCount,
} from "../src/persona/archive.ts";
import {
  CONSOLIDATE_AFTER_NEW_BULLETS,
  consolidatePerson,
  countObservations,
  shouldConsolidate,
} from "../src/persona/consolidate.ts";
import { judgmentModel } from "../src/persona/maintainer.ts";
import { principlesDerivedAt, renderPrinciples } from "../src/persona/principles.ts";

/**
 * The gates between the maintainer, the consolidator and the archiver, as
 * they behaved on the live files on 2026-10-23:
 *
 *   - the archiver pinned the consolidation trigger, so 6 of 9 chats with
 *     principles had stopped consolidating (the operator's DM since 10-02);
 *   - the size gate's recency floors were counts calibrated for 140-character
 *     notes, notes ran 235-625 bytes, and live files sat at 20-54 KB;
 *   - group Open Items was exempt and the largest section of the biggest
 *     group files;
 *   - a full rewrite dropped observations into a .bak the next rewrite
 *     overwrote.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-gates-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const day = (n: number) => {
  const d = new Date(Date.UTC(2026, 8, 1) + n * 86_400_000);
  return d.toISOString().slice(0, 10);
};
/** A note the length notes actually are, not the 140 the prompt asks for. */
const note = (n: number, text = "observation") =>
  `- **${day(n)}** — ${text} ${n}: ${"a realistic amount of detail about what happened ".repeat(7)}`;

function personFile(learned: string[], openItems: string[], principlesAt?: number): string {
  return [
    "# Test Person",
    "",
    ...(principlesAt === undefined
      ? []
      : [
          renderPrinciples(
            [{ rule: "Lead with the verdict, then ship.", evidence: [] }],
            principlesAt,
          ),
          "",
        ]),
    "## Who They Are",
    "A test subject.",
    "",
    "## What I've Learned",
    ...learned,
    "",
    "## Open Items",
    ...openItems,
    "",
  ].join("\n");
}

describe("the consolidation trigger survives the archiver", () => {
  test("new observations count even after the size gate moves old ones out", () => {
    const name = "15550100001.md";
    const path = join(dir, name);
    const learned = Array.from({ length: 30 }, (_, i) => note(i));
    let body = personFile(learned, [], 0);
    // Stamp the way the last pass would have: everything recorded so far.
    body = body.replace(
      "Derived at 0 observations",
      `Derived at ${countObservations(body)} observations`,
    );
    writeFileSync(path, body);
    archivePersonFile(name, dir);

    // The maintainer's loop: append a couple, then archive. Repeat.
    let next = 100;
    for (let pass = 0; pass < CONSOLIDATE_AFTER_NEW_BULLETS / 2; pass++) {
      const cur = readFileSync(path, "utf8").split("\n");
      const at = cur.indexOf("## Open Items") - 1;
      cur.splice(at, 0, note(next++), note(next++));
      writeFileSync(path, cur.join("\n"));
      archivePersonFile(name, dir);
    }
    const live = readFileSync(path, "utf8");
    // The bug: the live count is held near the stamp by the archiver.
    expect(shouldConsolidate(live)).toBeFalse();
    // Counting what was recorded, the pass is due.
    expect(shouldConsolidate(live, archivedObservationCount(path))).toBeTrue();
  });

  test("the stamp a pass writes is live plus archived", async () => {
    const path = join(dir, "p.md");
    writeFileSync(path, personFile([note(1), note(2)], []));
    mkdirSync(join(dir, "archive"));
    writeFileSync(archivePathFor(path), `# P — archived history\n\n${note(0)}\n${note(-1)}\n`);
    const r = await consolidatePerson(
      "p",
      async () =>
        JSON.stringify({ principles: [{ rule: "A rule worth keeping here.", evidence: [] }] }),
      undefined,
      () => path,
    );
    expect(r.ok).toBeTrue();
    expect(principlesDerivedAt(readFileSync(path, "utf8"))).toBe(4);
  });
});

describe("the size gate can reach what it protects", () => {
  test("a recency floor holds that many notes' worth of bytes, not that many bullets", () => {
    const name = "15550100002.md";
    const items = Array.from({ length: 60 }, (_, i) => note(i, "open item"));
    const body = personFile([], items);
    writeFileSync(join(dir, name), body);
    expect(Buffer.byteLength(body)).toBeGreaterThan(ARCHIVE_TRIGGER_BYTES);
    archivePersonFile(name, dir);

    const live = readFileSync(join(dir, name), "utf8");
    const kept = live.split("\n").filter((l) => l.includes("open item"));
    // Counted in bullets, 40 of these (15 KB) were untouchable and the file
    // could never get near its target. Counted in bytes, it gets there.
    expect(kept.length).toBeLessThan(SECTION_KEEP_RECENT.get("Open Items")!);
    expect(Buffer.byteLength(live)).toBeLessThanOrEqual(ARCHIVE_TARGET_BYTES);
    // The newest stay, the oldest went, and nothing was lost.
    expect(live).toContain(day(59));
    expect(live).not.toContain(`${day(0)}**`);
    const archived = readFileSync(archivePathFor(join(dir, name)), "utf8");
    expect(countObservations(live) + countObservations(archived)).toBe(60);
  });

  test("notes the size the maintainer is asked for keep the full count", () => {
    const name = "15550100003.md";
    const short = (i: number) => `- **${day(i)}** — short open item ${i}`;
    expect(Buffer.byteLength(short(10))).toBeLessThanOrEqual(NOTE_BYTES);
    const filler = Array.from({ length: 80 }, (_, i) => note(i));
    writeFileSync(
      join(dir, name),
      personFile(
        filler,
        Array.from({ length: 50 }, (_, i) => short(i)),
      ),
    );
    archivePersonFile(name, dir);
    const live = readFileSync(join(dir, name), "utf8");
    const kept = live.split("\n").filter((l) => l.includes("short open item")).length;
    expect(kept).toBe(SECTION_KEEP_RECENT.get("Open Items"));
  });

  test("the newest few stay however long they are", () => {
    const name = "15550100004.md";
    const huge = (i: number) => `- **${day(i)}** — open item ${i}: ${"x".repeat(9_000)}`;
    writeFileSync(
      join(dir, name),
      personFile(
        [],
        Array.from({ length: 6 }, (_, i) => huge(i)),
      ),
    );
    archivePersonFile(name, dir);
    const live = readFileSync(join(dir, name), "utf8");
    expect(live.split("\n").filter((l) => l.includes("open item")).length).toBe(MIN_RECENT_BULLETS);
  });

  test("a group's Open Items sheds its oldest like a person's", () => {
    const name = "any-deadbeef.md";
    const body = [
      "# The Crew",
      "",
      "## Who's In It",
      "- **2026-08-15** — Alice plans the meals",
      "",
      "## Open Items",
      ...Array.from({ length: 60 }, (_, i) => note(i, "group plan")),
      "",
    ].join("\n");
    writeFileSync(join(dir, name), body);
    expect(archiveGroupFile(name, dir)).not.toBeNull();
    const live = readFileSync(join(dir, name), "utf8");
    expect(live).toContain("Alice plans the meals");
    expect(live).toContain(day(59));
    expect(live).not.toContain(`${day(0)}**`);
    const archived = readFileSync(archivePathFor(join(dir, name)), "utf8");
    expect(countObservations(live) + countObservations(archived)).toBe(61);
  });
});

describe("a full rewrite loses nothing", () => {
  test("dated bullets the rewrite dropped go to the archive under their section", () => {
    const path = join(dir, "15550100005.md");
    const old = personFile([note(1), note(2), note(3)], [note(4, "open item")]);
    const rewritten = personFile([note(3)], []);
    writeFileSync(path, old);
    expect(archiveRewriteDrops(path, old, rewritten)).toBe(3);
    const archived = readFileSync(archivePathFor(path), "utf8");
    expect(archived).toContain("## What I've Learned (removed by rewrite");
    expect(archived).toContain("## Open Items (removed by rewrite");
    expect(archived).toContain(note(1));
    expect(archived).toContain(note(4, "open item"));
    // What the rewrite kept verbatim is not duplicated; prose is not a bullet.
    expect(archived).not.toContain(note(3));
    expect(archived).not.toContain("A test subject.");
    // Together the two files hold every observation the old file held.
    for (const l of old.split("\n").filter((x) => x.startsWith("- **"))) {
      expect(`${rewritten}\n${archived}`).toContain(l);
    }
  });

  test("a rewrite that keeps everything archives nothing", () => {
    const path = join(dir, "15550100006.md");
    const body = personFile([note(1)], []);
    expect(archiveRewriteDrops(path, body, `${body}\n## Extra\nmore prose`)).toBe(0);
  });

  test("the maintainer archives before each of its full rewrites", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/persona/maintainer.ts"), "utf8");
    for (const writer of ["writePersonFile({ handle", "writeGroupFile({ chatGuid"]) {
      const at = src.indexOf(writer);
      expect(at).toBeGreaterThan(-1);
      const before = src.slice(src.lastIndexOf("if (parsed.fullRewrite)", at), at);
      expect(before).toContain(
        "archiveRewriteDrops(current.path, current.body, parsed.fullRewrite)",
      );
    }
  });
});

describe("consolidation has its own model", () => {
  const cfg = (extra: Record<string, unknown> = {}) =>
    ConfigSchema.parse({
      self: { handles: [] },
      allowlist: {},
      identity: {},
      people_maintainer: { model: "append-model", ...extra },
    }).people_maintainer;

  test("unset, it is the append pass's model: no change in cost", () => {
    expect(cfg().consolidation_model).toBe("");
    expect(judgmentModel(cfg())).toBe("append-model");
  });

  test("set, consolidation uses it", () => {
    expect(judgmentModel(cfg({ consolidation_model: "judge-model" }))).toBe("judge-model");
  });

  test("both consolidation calls go through it", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/persona/maintainer.ts"), "utf8");
    expect(src.match(/spawnMaintainerModel\(judgmentModel\(cfg\)/g)?.length).toBe(2);
    expect(
      src.match(/shouldConsolidate\(before\.body, archivedObservationCount\(before\.path\)\)/g)
        ?.length,
    ).toBe(2);
  });
});
