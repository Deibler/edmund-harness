import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseIdeations, portalIdeas } from "../src/ideation/portal.ts";
import { IdeationStore, ideationsDir, newIdeationId } from "../src/ideation/store.ts";

const SAM = "imessage:dm:+15550100001";
const ALEX = "imessage:dm:+15550100002";

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "ideation-portal-"));
  const store = new IdeationStore(dataDir);
  const add = (sessionKey: string, title: string, ready: boolean) => {
    const id = newIdeationId();
    store.create({
      id,
      sessionKey,
      thread: "the night sky",
      threadKey: "the night sky",
      title,
      pitch: "A page.",
      why: "Asked often.",
      brief: "Build it.",
      evidence: [1, 2, 3],
      days: ["2026-10-24", "2026-10-27", "2026-11-01"],
      createdMs: 1_000,
    });
    if (ready) {
      store.markReady(id, 5_000, `https://pages.example.com/i/${id}/`);
      const dir = join(ideationsDir(dataDir), id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html></html>");
    }
    return id;
  };
  return { dataDir, store, add };
}

describe("portalIdeas", () => {
  test("nothing, and no database created, where no page was ever built", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ideation-portal-none-"));
    expect(portalIdeas(dataDir, SAM)).toEqual({ threads: [], pages: [] });
    expect(existsSync(join(dataDir, "ideations.db"))).toBe(false);
  });

  test("only published pages, only theirs, with the picture beside the page", () => {
    const s = setup();
    const ready = s.add(SAM, "Sunset Compass", true);
    s.add(SAM, "Still building", false);
    s.add(ALEX, "Someone else's", true);
    const r = portalIdeas(s.dataDir, SAM);
    expect(r.pages.map((p) => p.title)).toEqual(["Sunset Compass"]);
    expect(r.pages[0]?.thumbUrl).toBe(`https://pages.example.com/i/${ready}/thumb.jpg`);
    expect(r.pages[0]?.days).toBe(3);
  });

  test("interests seen on one day only are not shown as recurring", () => {
    const s = setup();
    s.store.saveThreads(
      SAM,
      [
        {
          label: "the night sky",
          days: ["2026-10-24", "2026-10-27"],
          lastSeenMs: 2,
          excluded: null,
        },
        { label: "snowboarding", days: ["2026-11-03"], lastSeenMs: 3, excluded: null },
      ],
      10,
    );
    expect(portalIdeas(s.dataDir, SAM).threads.map((t) => t.label)).toEqual(["the night sky"]);
  });
});

describe("eraseIdeations", () => {
  test("removes their pages, files, runs and interests, and nobody else's", () => {
    const s = setup();
    const mine = s.add(SAM, "Sunset Compass", true);
    const theirs = s.add(ALEX, "River Map", true);
    s.store.recordRun({ sessionKey: SAM, ranMs: 1, outcome: "picked", detail: "", costUsd: 0.2 });
    s.store.saveThreads(
      SAM,
      [{ label: "the night sky", days: ["a", "b"], lastSeenMs: 1, excluded: null }],
      1,
    );
    expect(eraseIdeations(s.dataDir, SAM)).toBe(1);
    expect(existsSync(join(ideationsDir(s.dataDir), mine))).toBe(false);
    expect(s.store.get(mine)).toBeNull();
    expect(s.store.lastRunMs(SAM)).toBeNull();
    expect(s.store.threads(SAM)).toEqual([]);
    expect(s.store.get(theirs)?.status).toBe("ready");
    expect(existsSync(join(ideationsDir(s.dataDir), theirs, "index.html"))).toBe(true);
  });
});
