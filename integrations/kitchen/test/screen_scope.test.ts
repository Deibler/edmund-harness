/**
 * Which household list a session may edit on screen.
 *
 * Several households' lists sit side by side in the same Notes account, so a
 * wrong answer here means Edmund writes one family's groceries into another's
 * list. Membership decides it, the same binding the kitchen tools use.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../../src/config/config.ts";
import { screenScope } from "../screen-scope.ts";
import { createAccount } from "../src/accounts.ts";
import { noteTitle } from "../src/notelist.ts";

const ALEX = "imessage:dm:+15550100001";
const SAM = "imessage:dm:+15550100002";
const HOUSE_GROUP = "imessage:group:any;+;0000000000000000000000000000abcd";
const JORDAN = "imessage:dm:+15550100003";
const config = ConfigSchema.parse({
  self: { handles: [] },
  allowlist: { dm: [], groups: [] },
  identity: {},
});

let dir: string;
const before = process.env.KITCHEN_DIR;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kitchen-screen-scope-"));
  // KITCHEN_DIR, not useKitchenDir: screenScope applies the kitchen config,
  // which would otherwise point it back at the real data directory.
  process.env.KITCHEN_DIR = dir;
  createAccount("house", { members: [ALEX, SAM, HOUSE_GROUP] });
  createAccount("jordan", { members: [JORDAN] });
});
afterAll(() => {
  if (before === undefined) Reflect.deleteProperty(process.env, "KITCHEN_DIR");
  else process.env.KITCHEN_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});

describe("screenScope", () => {
  test("a member's DM and the household group own their list, and nothing else", () => {
    for (const key of [ALEX, SAM, HOUSE_GROUP]) {
      expect(screenScope(key, config)).toEqual({
        own: [noteTitle("house")],
        others: [noteTitle("jordan")],
      });
    }
  });

  test("another household's member owns only theirs", () => {
    expect(screenScope(JORDAN, config)).toEqual({
      own: [noteTitle("jordan")],
      others: [noteTitle("house")],
    });
  });

  test("a stranger owns no list and every list is someone else's", () => {
    const scope = screenScope("imessage:dm:+15550100009", config);
    expect(scope.own).toEqual([]);
    expect(scope.others.sort()).toEqual([noteTitle("house"), noteTitle("jordan")].sort());
  });

  test("the two households' lists have different titles", () => {
    expect(noteTitle("house")).not.toBe(noteTitle("jordan"));
  });
});
