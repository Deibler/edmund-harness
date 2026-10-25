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
  OPEN_ITEM_DAYS,
  SECTION_KEEP_RECENT,
  archiveGroupFile,
  archivePathFor,
  archivePersonFile,
  archiveRewriteDrops,
  archivedObservationCount,
  reconcileRewrite,
} from "../src/persona/archive.ts";
import {
  CONSOLIDATE_AFTER_NEW_BULLETS,
  CONSOLIDATION_PROMPT,
  GROUP_CONSOLIDATION_PROMPT,
  consolidatePerson,
  countObservations,
  shouldConsolidate,
} from "../src/persona/consolidate.ts";
import {
  applyFullRewrite,
  consolidateThenArchive,
  judgmentModel,
  settleMaintenance,
} from "../src/persona/maintainer.ts";
import {
  principlesDerivedAt,
  readPrinciples,
  renderPrinciples,
} from "../src/persona/principles.ts";

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
/** Noon Eastern on day(60), 2026-10-31: the clock the age tests run at. */
const NOW = Date.UTC(2026, 9, 31, 16);
/** A note the length notes actually are, not the 140 the prompt asks for. */
const note = (n: number, text = "observation", repeat = 7) =>
  `- **${day(n)}** — ${text} ${n}: ${"a realistic amount of detail about what happened ".repeat(repeat)}`;

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

const liveItems = (body: string, marker: string) =>
  body
    .split("\n")
    .filter((l) => l.includes(marker))
    .map((l) => Number(l.match(new RegExp(`${marker} (\\d+):`))?.[1]));

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
    expect(shouldConsolidate(live, 0)).toBeFalse();
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
    const after = readFileSync(path, "utf8");
    expect(principlesDerivedAt(after)).toBe(4);
    // Dated, so the next pass knows which archived observations are new.
    expect(after).toMatch(/Derived at 4 observations on \d{4}-\d{2}-\d{2}\./);
  });
});

describe("consolidation sees what the size gate moved out", () => {
  const stamped = (on: string | null) =>
    personFile([note(40)], [], 10).replace(
      "Derived at 10 observations",
      `Derived at 10 observations${on ? ` on ${on}` : ""}`,
    );

  test("observations archived since the last pass are in the prompt", async () => {
    const path = join(dir, "p.md");
    writeFileSync(path, stamped(day(35)));
    mkdirSync(join(dir, "archive"));
    writeFileSync(
      archivePathFor(path),
      `# P — archived history\n\n${note(30, "seen before")}\n${note(37, "moved out unseen")}\n`,
    );
    let prompt = "";
    await consolidatePerson(
      "p",
      async (_s, user) => {
        prompt = user;
        return null;
      },
      undefined,
      () => path,
    );
    expect(prompt).toContain("moved out unseen 37");
    expect(prompt).not.toContain("seen before 30");
  });

  test("an old stamp with no date falls back to the newest evidence date", async () => {
    const path = join(dir, "p.md");
    const body = personFile([note(40)], []).replace(
      "## Who They Are",
      `${renderPrinciples([{ rule: "Lead with the verdict, then ship.", evidence: [day(33)] }], 10)}\n\n## Who They Are`,
    );
    writeFileSync(path, body);
    mkdirSync(join(dir, "archive"));
    writeFileSync(archivePathFor(path), `# P\n\n${note(32, "older")}\n${note(34, "newer")}\n`);
    let prompt = "";
    await consolidatePerson(
      "p",
      async (_s, user) => {
        prompt = user;
        return null;
      },
      undefined,
      () => path,
    );
    expect(prompt).toContain("newer 34");
    expect(prompt).not.toContain("older 32");
  });

  test("a principle whose evidence was archived is not retired for that", () => {
    for (const p of [CONSOLIDATION_PROMPT, GROUP_CONSOLIDATION_PROMPT]) {
      expect(p).toContain("is NOT unsupported");
      expect(p).not.toMatch(/whether the file still\s+supports it/);
    }
  });

  test("no rules this time keeps the standing ones and still stamps", async () => {
    const path = join(dir, "p.md");
    writeFileSync(
      path,
      personFile(
        Array.from({ length: 20 }, (_, i) => note(i)),
        [],
        3,
      ),
    );
    const before = readFileSync(path, "utf8");
    expect(shouldConsolidate(before, 0)).toBeTrue();
    const r = await consolidatePerson(
      "p",
      async () => '{"principles": [], "revised": "nothing new"}',
      undefined,
      () => path,
    );
    expect(r.ok).toBeTrue();
    const after = readFileSync(path, "utf8");
    expect(readPrinciples(after).map((p) => p.rule)).toEqual(["Lead with the verdict, then ship."]);
    // Stamped, so the next maintainer pass does not run it again.
    expect(shouldConsolidate(after, 0)).toBeFalse();
  });
});

describe("the size gate can reach what it protects", () => {
  test("a history floor holds that many notes' worth of bytes, not that many bullets", () => {
    const name = "15550100002.md";
    const body = personFile(
      Array.from({ length: 60 }, (_, i) => note(i, "observation", 18)),
      [],
    );
    writeFileSync(join(dir, name), body);
    expect(Buffer.byteLength(body)).toBeGreaterThan(ARCHIVE_TRIGGER_BYTES);
    archivePersonFile(name, dir, undefined, NOW);

    const live = readFileSync(join(dir, name), "utf8");
    // Counted in bullets, 15 of these (13.5 KB) were untouchable and the file
    // could not reach its target. Counted in bytes, it does.
    expect(liveItems(live, "observation").length).toBeLessThan(15);
    expect(Buffer.byteLength(live)).toBeLessThanOrEqual(ARCHIVE_TARGET_BYTES);
    expect(live).toContain(day(59));
    const archived = readFileSync(archivePathFor(join(dir, name)), "utf8");
    expect(countObservations(live) + countObservations(archived)).toBe(60);
  });

  test("history notes the size the maintainer is asked for keep the full count", () => {
    const name = "15550100003.md";
    const short = (i: number) => `- **${day(i)}** — short lesson ${i}`;
    expect(Buffer.byteLength(short(10))).toBeLessThanOrEqual(NOTE_BYTES);
    const body = [
      personFile(
        Array.from({ length: 30 }, (_, i) => short(i)),
        [],
      ),
      "## Shared History",
      ...Array.from({ length: 40 }, (_, i) => note(i, "event")),
    ].join("\n");
    writeFileSync(join(dir, name), body);
    archivePersonFile(name, dir, undefined, NOW);
    const live = readFileSync(join(dir, name), "utf8");
    expect(liveItems(live, "short lesson").length).toBe(15);
  });

  test("the newest few history notes stay however long they are", () => {
    const name = "15550100004.md";
    const huge = (i: number) => `- **${day(i)}** — lesson ${i}: ${"x".repeat(9_000)}`;
    writeFileSync(
      join(dir, name),
      personFile(
        Array.from({ length: 6 }, (_, i) => huge(i)),
        [],
      ),
    );
    archivePersonFile(name, dir, undefined, NOW);
    const live = readFileSync(join(dir, name), "utf8");
    expect(liveItems(live, "lesson").length).toBe(MIN_RECENT_BULLETS);
  });
});

describe("open commitments are not archived by size", () => {
  test("an open item stays while it is recent, however large the section is", () => {
    const name = "15550100005.md";
    // 900-byte items, one a day for 60 days: the last 14 are 12.6 KB, far
    // over any byte floor, and all of them stay.
    const items = Array.from({ length: 60 }, (_, i) => note(i, "open item", 18));
    writeFileSync(join(dir, name), personFile([], items));
    archivePersonFile(name, dir, undefined, NOW);
    const kept = liveItems(readFileSync(join(dir, name), "utf8"), "open item");
    const recent = Array.from({ length: 60 }, (_, i) => i).filter((i) => 60 - i <= OPEN_ITEM_DAYS);
    expect(kept.sort((a, b) => a - b)).toEqual(recent);
  });

  test("an old one goes however small the section is", () => {
    const name = "15550100006.md";
    const items = Array.from({ length: 20 }, (_, i) => note(i, "open item"));
    const body = [
      personFile([], items),
      "## Shared History",
      ...Array.from({ length: 30 }, (_, i) => note(i, "event")),
    ].join("\n");
    writeFileSync(join(dir, name), body);
    archivePersonFile(name, dir, undefined, NOW);
    // All 20 are weeks old: only the newest few stay.
    expect(
      liveItems(readFileSync(join(dir, name), "utf8"), "open item").sort((a, b) => a - b),
    ).toEqual([17, 18, 19]);
  });

  test("the count floor still caps a burst of recent items", () => {
    const name = "15550100007.md";
    const items = Array.from({ length: 60 }, (_, i) =>
      note(50 + Math.floor(i / 6), `open item ${i} on`),
    );
    writeFileSync(join(dir, name), personFile([], items));
    archivePersonFile(name, dir, undefined, NOW);
    const live = readFileSync(join(dir, name), "utf8");
    expect(live.split("\n").filter((l) => l.includes("open item")).length).toBe(
      SECTION_KEEP_RECENT.get("Open Items"),
    );
  });

  test("a group's Open Items is protected and sheds the same way", () => {
    const name = "any-deadbeef.md";
    const body = [
      "# The Crew",
      "",
      "## Who's In It",
      "- **2026-08-15** — Alice plans the meals",
      "",
      "## Open Items",
      ...Array.from({ length: 60 }, (_, i) => note(i, "group plan", 18)),
      "",
    ].join("\n");
    writeFileSync(join(dir, name), body);
    expect(archiveGroupFile(name, dir, NOW)).not.toBeNull();
    const live = readFileSync(join(dir, name), "utf8");
    expect(live).toContain("Alice plans the meals");
    const kept = liveItems(live, "group plan");
    expect(Math.min(...kept)).toBe(60 - OPEN_ITEM_DAYS);
    const archived = readFileSync(archivePathFor(join(dir, name)), "utf8");
    expect(countObservations(live) + countObservations(archived)).toBe(61);
  });
});

describe("a full rewrite loses nothing", () => {
  test("dated bullets the rewrite dropped go to the archive under their section", () => {
    const path = join(dir, "15550100008.md");
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
  });

  test("a note the live turn appended during the model call is merged in", () => {
    const snapshot = personFile([note(1), note(2)], [note(3, "open item")]);
    const appended = note(9, "added meanwhile");
    const latest = snapshot.replace(note(2), `${note(2)}\n${appended}`);
    const rewrite = personFile([note(2)], []);
    const merged = reconcileRewrite(snapshot, latest, rewrite);
    expect(merged).not.toBeNull();
    const learned = merged!.slice(
      merged!.indexOf("## What I've Learned"),
      merged!.indexOf("## Open Items"),
    );
    expect(learned).toContain(appended);
  });

  test("a file edited or trimmed during the call is not overwritten", () => {
    const snapshot = personFile([note(1), note(2)], []);
    const rewrite = personFile([note(2)], []);
    // The live turn removed a note (say, asked to forget it).
    expect(reconcileRewrite(snapshot, snapshot.replace(`${note(1)}\n`, ""), rewrite)).toBeNull();
    // Or reworded prose.
    expect(
      reconcileRewrite(snapshot, snapshot.replace("A test subject.", "A tester."), rewrite),
    ).toBeNull();
    // Nothing changed: the rewrite as produced.
    expect(reconcileRewrite(snapshot, snapshot, rewrite)).toBe(rewrite);
  });

  test("live and archive together hold everything the file held when it was written", () => {
    const path = join(dir, "15550100009.md");
    const snapshot = personFile([note(1), note(2), note(3)], []);
    const latest = snapshot.replace(note(3), `${note(3)}\n${note(9, "added meanwhile")}`);
    writeFileSync(path, latest);
    const written = applyFullRewrite(
      { path, body: snapshot },
      () => ({ path, body: readFileSync(path, "utf8") }),
      personFile([note(3)], []),
      (body) => writeFileSync(path, body),
      "test",
    );
    expect(written).not.toBeNull();
    const live = readFileSync(path, "utf8");
    const archived = readFileSync(archivePathFor(path), "utf8");
    for (const l of latest.split("\n").filter((x) => x.startsWith("- **"))) {
      expect(`${live}\n${archived}`).toContain(l);
    }
    // The appended note is live, not archived.
    expect(live).toContain("added meanwhile 9");
    expect(archived).not.toContain("added meanwhile 9");
  });

  test("a rewrite that cannot be applied writes nothing and reports it", () => {
    const path = join(dir, "15550100010.md");
    const snapshot = personFile([note(1)], []);
    writeFileSync(path, snapshot);
    let wrote = false;
    const changed = applyFullRewrite(
      { path, body: snapshot },
      () => ({ path, body: personFile([], []) }),
      personFile([], []),
      () => {
        wrote = true;
      },
      "test",
    );
    expect(changed).toBeNull();
    expect(wrote).toBeFalse();
    const threw = applyFullRewrite(
      { path, body: snapshot },
      () => ({ path, body: snapshot }),
      personFile([], []),
      () => {
        throw new Error("disk full");
      },
      "test",
    );
    expect(threw).toBeNull();
  });

  test("a file deleted during the model call stays deleted", () => {
    const path = join(dir, "15550100011.md");
    let wrote = false;
    const r = applyFullRewrite(
      { path, body: personFile([note(1)], []) },
      () => null,
      personFile([], []),
      () => {
        wrote = true;
      },
      "test",
    );
    expect(r).toBeNull();
    expect(wrote).toBeFalse();
  });

  test("a retried rewrite does not archive the same drops twice", () => {
    const path = join(dir, "15550100012.md");
    const old = personFile([note(1), note(2)], []);
    writeFileSync(path, old);
    const fail = () => {
      throw new Error("disk full");
    };
    const attempt = (write: (b: string) => void) =>
      applyFullRewrite(
        { path, body: old },
        () => ({ path, body: readFileSync(path, "utf8") }),
        personFile([note(2)], []),
        write,
        "test",
      );
    expect(attempt(fail)).toBeNull();
    expect(archivedObservationCount(path)).toBe(1);
    expect(attempt((b) => writeFileSync(path, b))).not.toBeNull();
    expect(archivedObservationCount(path)).toBe(1);
  });

  test("a note the rewrite already carries is not merged in twice", () => {
    const snapshot = personFile([note(1)], []);
    const appended = note(9, "added meanwhile");
    const latest = snapshot.replace(note(1), `${note(1)}\n${appended}`);
    const merged = reconcileRewrite(snapshot, latest, personFile([note(1), appended], []));
    expect(merged!.split("\n").filter((l) => l === appended)).toHaveLength(1);
  });
});

describe("when an exchange counts as maintained", () => {
  const run = (parsed: { fullRewrite: string | null }, dryRun: boolean, written: string | null) => {
    const calls: string[] = [];
    const settled = settleMaintenance(parsed, dryRun, {
      rewrite: () => {
        calls.push("rewrite");
        return written;
      },
      stamp: () => calls.push("stamp"),
    });
    return { settled, calls };
  };

  test("a rewrite that did not land leaves it unmaintained, to be retried", () => {
    const { settled, calls } = run({ fullRewrite: "body" }, false, null);
    expect(settled.kind).toBe("not-applied");
    expect(calls).toEqual(["rewrite"]);
  });

  test("a rewrite that landed is stamped after it, never before", () => {
    const { settled, calls } = run({ fullRewrite: "body" }, false, "body");
    expect(settled).toEqual({ kind: "rewrote", written: "body" });
    expect(calls).toEqual(["rewrite", "stamp"]);
  });

  test("a dry run is stamped and writes nothing; notes are stamped then appended", () => {
    expect(run({ fullRewrite: "body" }, true, "body").calls).toEqual(["stamp"]);
    const appending = run({ fullRewrite: null }, false, null);
    expect(appending.settled.kind).toBe("append");
    expect(appending.calls).toEqual(["stamp"]);
  });

  test("both maintainer paths stamp only through it", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/persona/maintainer.ts"), "utf8");
    expect(src.match(/setLastMaintainedAtMs/g)?.length).toBe(2);
    expect(
      src.match(/stamp: \(\) => deps\.state\.setLastMaintainedAtMs\(sessionKey, Date\.now\(\)\)/g)
        ?.length,
    ).toBe(2);
    expect(src.match(/const settled = settleMaintenance\(parsed, cfg\.dry_run, \{/g)?.length).toBe(
      2,
    );
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
    expect(src.match(/spawnMaintainerModel\(\s*judgmentModel\(cfg\)/g)?.length).toBe(2);
    expect(
      src.match(/shouldConsolidate\(before\.body, archivedObservationCount\(before\.path\)\)/g)
        ?.length,
    ).toBe(2);
  });
});

describe("the size gate waits for current rules", () => {
  const run = async (due: boolean, consolidate: () => Promise<{ ok: boolean; reason?: string }>) => {
    const calls: string[] = [];
    const outcome = await consolidateThenArchive({
      subject: "dm:test",
      due,
      consolidate: async () => {
        calls.push("consolidate");
        return consolidate();
      },
      archive: () => {
        calls.push("archive");
      },
    });
    return { outcome, calls };
  };

  test("a due consolidation that succeeds is followed by the sweep", async () => {
    expect(await run(true, async () => ({ ok: true }))).toEqual({
      outcome: "archived",
      calls: ["consolidate", "archive"],
    });
  });

  test("a due consolidation that fails holds the sweep", async () => {
    expect(await run(true, async () => ({ ok: false, reason: "model call failed" }))).toEqual({
      outcome: "held",
      calls: ["consolidate"],
    });
  });

  test("a due consolidation that throws holds the sweep", async () => {
    const r = await run(true, async () => {
      throw new Error("timeout");
    });
    expect(r).toEqual({ outcome: "held", calls: ["consolidate"] });
  });

  test("with nothing due, the sweep runs and nothing is consolidated", async () => {
    expect(await run(false, async () => ({ ok: true }))).toEqual({
      outcome: "archived",
      calls: ["archive"],
    });
  });

  test("both maintainer paths go through it, with the longer timeout", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/persona/maintainer.ts"), "utf8");
    expect(src.match(/await consolidateThenArchive\(\{/g)?.length).toBe(2);
    expect(src.match(/CONSOLIDATION_TIMEOUT_MS,\n/g)?.length).toBe(2);
    expect(src.match(/archivePersonFile\(/g)?.length).toBe(1);
    expect(src.match(/archiveGroupFile\(/g)?.length).toBe(1);
  });
});
