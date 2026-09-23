/**
 * Kitchen judgement belongs to the household's main session.
 *
 * The unattended passes may fold ledger state and render pages, but they must
 * not ask a second model to decide what this household should eat. These tests
 * pin the handoff itself: one wake per session, bounded retries, validated
 * writes, and no provider call in the judgement modules.
 */

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobInput } from "../../../src/cron/types.ts";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-judgment-"));
const RECIPES = join(BASE, "recipes.json");
process.env.KITCHEN_DIR = BASE;
process.env.KITCHEN_RECIPES = RECIPES;

const SAM = "imessage:dm:+15550000001";
const ALEX = "imessage:dm:+15550000002";
const GROUP = "imessage:group:any;+;test-group";

mkdirSync(join(BASE, "tenants", "t"), { recursive: true });
writeFileSync(
  join(BASE, "tenants.json"),
  JSON.stringify({
    version: 1,
    tenants: {
      t: {
        name: "test",
        created: "2026-01-01T00:00:00+00:00",
        members: [SAM, ALEX, GROUP],
        people: { [SAM]: "Sam", [ALEX]: "Alex" },
        wake: SAM,
      },
    },
  }),
);
writeFileSync(
  RECIPES,
  JSON.stringify({
    recipes: [
      {
        id: "known-dinner",
        name: "Known Dinner",
        desc: "Already in the catalog.",
        minutes: 30,
        needs: [["rice", 1]],
        cat: "dinner",
      },
    ],
    history_seed: [],
  }),
);

const { getAccount } = await import("../src/accounts.ts");
const { saveExplore } = await import("../src/explore.ts");
const { readOverlay, saveIdeas } = await import("../src/ideas.ts");
const { append } = await import("../src/store.ts");
const { describeRequest, eventText, sessionFor, wake, wakeForRequests } = await import(
  "../src/wake.ts"
);

append("t", [
  {
    op: "add",
    item: "rice",
    qty: 4,
    unit: "cup",
    fields: { name: "Rice", cat: "pantry", loc: "pantry" },
  },
]);

test("a site question wakes the person who asked, and unattended work uses the household wake chat", () => {
  const account = getAccount("t")!;
  expect(sessionFor(account, ALEX)).toBe(ALEX);
  expect(sessionFor(account, null)).toBe(SAM);
  expect(sessionFor(account, GROUP)).toBe(SAM);
});

test("wake batches one turn per session and bounds retries", () => {
  const account = getAccount("t")!;
  const jobs: JobInput[] = [];
  const create = (input: JobInput) => {
    jobs.push(input);
    return { id: `job-${jobs.length}` };
  };
  const at = Date.UTC(2026, 8, 19, 12, 0, 0);
  const items = [
    { key: "one", requester: ALEX, line: "First answer." },
    { key: "two", requester: ALEX, line: "Second answer." },
  ];

  expect(wake("t", account, items, { create, now: at }).woke).toHaveLength(1);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.sessionKey).toBe(ALEX);
  expect(jobs[0]!.systemEvent).toContain("KEEP_QUIET");

  expect(wake("t", account, items, { create, now: at + 60_000 }).held).toEqual([
    { key: "one", why: "recent" },
    { key: "two", why: "recent" },
  ]);
  expect(wake("t", account, items, { create, now: at + 21 * 60_000 }).woke).toHaveLength(1);
  expect(wake("t", account, items, { create, now: at + 42 * 60_000 }).woke).toHaveLength(1);
  expect(wake("t", account, items, { create, now: at + 63 * 60_000 }).held).toEqual([
    { key: "one", why: "exhausted" },
    { key: "two", why: "exhausted" },
  ]);
  expect(jobs).toHaveLength(3);
});

test("a site answer ends quietly; its reply is not a text", () => {
  const body = eventText(getAccount("t")!, [{ key: "x", line: "Use kitchen_chat." }], ALEX);
  expect(body.endsWith("reply with exactly KEEP_QUIET.")).toBe(true);
});

test("Make is a conversation with the person who tapped, not a silent write", () => {
  const account = getAccount("t")!;
  const jobs: JobInput[] = [];
  const create = (input: JobInput) => {
    jobs.push(input);
    return { id: `job-${jobs.length}` };
  };
  wakeForRequests(
    "t",
    account,
    [
      {
        kind: "make",
        ts: "2026-09-23T17:00:00.000Z",
        client_ts: "c-make",
        profile: ALEX,
        recipe: "chicken-parm",
        name: "Chicken parm",
      },
    ],
    { create, now: Date.UTC(2026, 8, 23, 17, 0, 0) },
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.sessionKey).toBe(ALEX);
  const body = jobs[0]!.systemEvent;
  expect(body).not.toContain("KEEP_QUIET");
  expect(body).toContain("Text them in this chat");
  expect(body).toContain("ask them one short line first");
});

test("an explore wake carries the exact tap key through to the save", () => {
  const line = describeRequest(getAccount("t")!, {
    kind: "explore",
    ts: "2026-09-19T12:00:00.000Z",
    client_ts: "client-1",
    profile: ALEX,
    text: "something Korean",
  });
  expect(line).toContain('kitchen_explore action:"save" key:');
  expect(line).toContain("2026-09-19T12:00:00.000Z|explore||client-1");
});

test("main-session ideas are still refused when they invent food", () => {
  const result = saveIdeas("t", [
    {
      id: "rice-bowl",
      name: "Rice Bowl",
      desc: "A useful dinner.",
      minutes: 20,
      cat: "dinner",
      health: 4,
      needs: [["rice", 1]],
    },
    {
      id: "ghost-bowl",
      name: "Ghost Bowl",
      desc: "Not actually cookable.",
      minutes: 20,
      cat: "dinner",
      health: 3,
      needs: [["ingredient-that-does-not-exist", 1]],
    },
  ]);

  expect(result.saved.map((recipe) => recipe.id)).toEqual(["rice-bowl"]);
  expect(result.rejected).toEqual([
    { id: "ghost-bowl", why: "unknown ingredient ingredient-that-does-not-exist" },
  ]);
  expect(readOverlay("t").recipes.map((recipe) => recipe.id)).toContain("rice-bowl");
});

test("explore drops catalog repeats and cannot put owned food on the buy list", () => {
  const { set, dropped } = saveExplore("t", [
    {
      name: "Known Dinner",
      desc: "A duplicate.",
      cuisine: "American",
      why: "It is not different.",
      buy: [],
      have: ["Rice"],
      minutes: 30,
      effort: "weeknight",
      method: "stovetop",
      spend: 2,
      health: 3,
    },
    {
      name: "Crispy Rice Supper",
      desc: "A genuinely different dinner.",
      cuisine: "Korean",
      why: "Different technique and flavor system.",
      buy: ["Rice", "gochujang"],
      have: [],
      minutes: 40,
      effort: "weeknight",
      method: "stovetop",
      spend: 2,
      health: 4,
    },
  ]);

  expect(dropped).toEqual(["Known Dinner"]);
  expect(set.dishes).toHaveLength(1);
  expect(set.dishes[0]!.buy).toEqual(["gochujang"]);
  expect(set.dishes[0]!.have).toEqual(["Rice"]);
});

test("judgement modules contain no direct model-provider call", () => {
  const root = join(import.meta.dir, "..");
  const files = [
    "src/drain.ts",
    "src/explore.ts",
    "src/ideas.ts",
    "src/onboard.ts",
    "src/shelfread.ts",
    "src/wake.ts",
    "scripts/daily.ts",
    "scripts/watch.ts",
  ];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    expect(source).not.toContain("api.openrouter.ai");
    expect(source).not.toContain("spawn_agent");
    expect(source).not.toContain("spawn_team");
  }
});
