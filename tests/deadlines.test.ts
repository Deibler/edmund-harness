import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../src/cron/store.ts";
import { DEADLINE_PREFIX, parseOutput, scheduleDeadlines } from "../src/persona/maintainer.ts";
import type { SessionKey } from "../src/sessions/key.ts";

const dir = mkdtempSync(join(tmpdir(), "deadlines-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const session = "dm:+15555550101" as SessionKey;
// 2026-11-01 12:00 UTC, a Sunday, after daylight saving ended.
const now = Date.UTC(2026, 10, 1, 12, 0);

describe("a dated commitment gets a turn that drafts it", () => {
  test("the note pass reports deadlines and drops undated ones", () => {
    const parsed = parseOutput(
      JSON.stringify({
        notes: [],
        deadlines: [
          { what: "grant application", due: "2026-11-13", deliverable: "the form answers" },
          { what: "something soon", due: "next week", deliverable: "x" },
        ],
        full_rewrite: null,
        reason: "",
      }),
      ["open-items"],
    );
    expect(parsed?.deadlines).toEqual([
      { what: "grant application", due: "2026-11-13", deliverable: "the form answers" },
    ]);
  });

  test("scheduled for 10:00 Eastern the day before, once", () => {
    const store = new CronStore(dir);
    try {
      const d = [{ what: "grant application", due: "2026-11-13", deliverable: "the form answers" }];
      expect(scheduleDeadlines(store, session, d, now)).toBe(1);
      expect(scheduleDeadlines(store, session, d, now)).toBe(0);
      const jobs = store
        .listActive(session)
        .filter((j) => j.systemEvent.startsWith(DEADLINE_PREFIX));
      expect(jobs).toHaveLength(1);
      // 2026-11-12 10:00 EST = 15:00 UTC.
      expect(jobs[0]?.nextFireMs).toBe(Date.UTC(2026, 10, 12, 15, 0));
      expect(jobs[0]?.systemEvent).toContain("Draft the form answers now");
      expect(jobs[0]?.systemEvent).toContain("KEEP_QUIET");
    } finally {
      store.close();
    }
  });

  test("past deadlines are skipped; one due today fires within the hour", () => {
    const store = new CronStore(mkdtempSync(join(dir, "b-")));
    try {
      expect(
        scheduleDeadlines(
          store,
          session,
          [{ what: "old thing", due: "2026-10-01", deliverable: "" }],
          now,
        ),
      ).toBe(0);
      expect(
        scheduleDeadlines(
          store,
          session,
          [{ what: "reply to the vendor", due: "2026-11-01", deliverable: "the reply" }],
          now,
        ),
      ).toBe(1);
      const job = store.listActive(session)[0];
      expect(job?.nextFireMs).toBe(now + 60 * 60_000);
    } finally {
      store.close();
    }
  });

  test("both maintainer paths schedule them", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/persona/maintainer.ts"), "utf8");
    expect(
      src.match(/scheduleDeadlines\(deps\.crons, sessionKey, parsed\.deadlines\)/g)?.length,
    ).toBe(2);
    const main = readFileSync(join(import.meta.dir, "..", "src/main.ts"), "utf8");
    expect(main).toContain("new PersonMaintainer({ config, state, chatDb, contacts, crons })");
  });
});
