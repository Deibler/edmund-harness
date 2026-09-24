/**
 * The shared note, now that only Edmund writes it, on screen.
 *
 * Nothing here touches a note. What is pinned is the decision around it: what
 * the note should say, when a changed list is worth waking a session for, that
 * a wake happens once per list rather than every ten seconds, and that a chat
 * with no screen tools for Notes is never woken to do an edit it cannot make.
 *
 * Runs against a scratch KITCHEN_DIR.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../../src/config/config.ts";
import type { JobInput } from "../../../src/cron/types.ts";

const BASE = mkdtempSync(join(tmpdir(), "kitchen-notelist-"));
const before = process.env.KITCHEN_DIR;
process.env.KITCHEN_DIR = BASE;
afterAll(() => {
  if (before === undefined) Reflect.deleteProperty(process.env, "KITCHEN_DIR");
  else process.env.KITCHEN_DIR = before;
  rmSync(BASE, { recursive: true, force: true });
});

const OWNER = "imessage:dm:+15550100001";
const PARTNER = "imessage:dm:+15550100002";
const GROUP = "imessage:group:any;+;0000000000000000000000000000beef";

const { createAccount, getAccount, joinAccount, updateAccount } = await import(
  "../src/accounts.ts"
);
const { addToList, removeFromList } = await import("../src/list.ts");
const notes = await import("../src/notelist.ts");
const { MAX_ATTEMPTS, wakeForNote } = await import("../src/wake.ts");
const { kitchenTools } = await import("../tools.ts");

let n = 0;
/** Members of the household a test made, keyed by id. */
const members = new Map<string, string>();
/**
 * A fresh household per test, so note state never leaks between them. Each
 * gets its own member, since a person belongs to one kitchen at most.
 */
function household(): string {
  const id = `h${++n}`;
  const member = `imessage:dm:+1555020${String(n).padStart(4, "0")}`;
  createAccount(id, { members: [member] });
  members.set(id, member);
  return id;
}
const add = (id: string, name: string, amount: string | null = null) =>
  addToList(id, [{ name, amount, cat: "produce", item: null, why: null, by: null }]);

describe("what the note says", () => {
  test("the title first, then each group's heading and its lines as checklist items", () => {
    const id = household();
    expect(notes.noteLines(id)).toEqual([
      { kind: "title", text: notes.noteTitle(id) },
      { kind: "text", text: "Nothing is out." },
    ]);
    add(id, "Limes", "4");
    const lines = notes.noteLines(id);
    expect(lines[0]).toEqual({ kind: "title", text: notes.noteTitle(id) });
    expect(lines.some((l) => l.kind === "heading")).toBe(true);
    expect(lines).toContainEqual({ kind: "item", text: "Limes, 4" });
    expect(notes.noteText(lines)).toContain("[ ] Limes, 4");
  });

  test("an adopted note's own title is used", () => {
    const id = household();
    updateAccount(id, { note_list: "Our groceries" });
    expect(notes.noteTitle(id)).toBe("Our groceries");
    expect(notes.noteLines(id)[0]!.text).toBe("Our groceries");
  });
});

describe("when Edmund is woken for it", () => {
  const T = Date.parse("2026-09-23T12:00:00Z");

  test("a household seen for the first time counts as up to date", () => {
    const id = household();
    add(id, "Limes");
    expect(notes.noteBehind(id)).toBe(false);
    expect(notes.noteDue(id, T).due).toBe(false);
    expect(notes.noteBehind(id)).toBe(false);
  });

  test("a changed list is due once it has held still for two minutes, and not before", () => {
    const id = household();
    notes.noteDue(id, T);
    add(id, "Limes");
    expect(notes.noteBehind(id)).toBe(true);
    expect(notes.noteDue(id, T + 1_000).due).toBe(false);
    expect(notes.noteDue(id, T + 1_000 + notes.SETTLE_MS - 1).due).toBe(false);
    // Another tap restarts the wait: a burst of changes is one wake.
    add(id, "Cilantro");
    expect(notes.noteDue(id, T + 1_000 + notes.SETTLE_MS).due).toBe(false);
    expect(notes.noteDue(id, T + 2_000 + 2 * notes.SETTLE_MS).due).toBe(true);
  });

  test("a list changed and changed back is not due", () => {
    const id = household();
    notes.noteDue(id, T);
    add(id, "Limes");
    notes.noteDue(id, T + 1_000);
    removeFromList(id, ["limes"]);
    expect(notes.noteBehind(id)).toBe(false);
    expect(notes.noteDue(id, T + 10 * notes.SETTLE_MS).due).toBe(false);
  });

  test("Edmund saying it is written stops the wake; the next change starts it again", () => {
    const id = household();
    notes.noteDue(id, T);
    add(id, "Limes");
    notes.noteDue(id, T);
    notes.markNoteWritten(id, T + 1_000);
    expect(notes.noteBehind(id)).toBe(false);
    expect(notes.noteDue(id, T + 10 * notes.SETTLE_MS).due).toBe(false);
    add(id, "Cilantro");
    expect(notes.noteBehind(id)).toBe(true);
  });

  test("a confirmed note keeps its title when somebody in the household is named", () => {
    const id = household();
    updateAccount(id, { people: { [members.get(id)!]: "Sam" } });
    notes.markNoteWritten(id, T);
    expect(notes.noteTitle(id)).toBe("Sam's Kitchen list");
    const partner = "imessage:dm:+15550309999";
    joinAccount(id, partner);
    updateAccount(id, { people: { [members.get(id)!]: "Sam", [partner]: "Alex" } });
    expect(notes.noteTitle(id)).toBe("Sam's Kitchen list");
    expect(notes.noteBehind(id)).toBe(false);
  });

  test("the site's Apple Notes button makes it due at once, without the wait", () => {
    const id = household();
    notes.noteDue(id, T);
    notes.requestNoteUpdate(id);
    expect(notes.noteDue(id, T).due).toBe(true);
    notes.markNoteWritten(id, T);
    expect(notes.noteDue(id, T).due).toBe(false);
  });

  test("a list that cannot be woken for is reported once, not every pass", () => {
    const id = household();
    expect(notes.holdNote(id, "abc")).toBe(true);
    expect(notes.holdNote(id, "abc")).toBe(false);
    expect(notes.holdNote(id, "def")).toBe(true);
  });
});

describe("the wake", () => {
  const jobs: JobInput[] = [];
  const create = (i: JobInput) => {
    jobs.push(i);
    return { id: `j${jobs.length}` };
  };

  test("goes to the household's session with the lines, the note's title and how to edit it", () => {
    const id = household();
    add(id, "Limes", "4");
    const acct = getAccount(id)!;
    const sig = notes.noteSignature(id);
    const w = wakeForNote(id, acct, sig, notes.noteLines(id), { create, now: 1 });
    expect(w.woke.map((x) => [x.session, x.keys])).toEqual([[members.get(id)!, [`note:${sig}`]]]);
    const event = jobs.at(-1)!.systemEvent!;
    expect(event).toContain(`"${notes.noteTitle(id)}"`);
    expect(event).toContain("[ ] Limes, 4");
    expect(event).toContain(notes.SENTINEL);
    expect(event).toContain("Never select all and paste");
    expect(event).toContain("noteWritten:true");
    expect(event).toContain("KEEP_QUIET");
  });

  test("one list wakes at most a few times; a new list is a new wake", () => {
    const id = household();
    add(id, "Limes");
    const acct = getAccount(id)!;
    const sig = notes.noteSignature(id);
    const lines = notes.noteLines(id);
    let woken = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      woken += wakeForNote(id, acct, sig, lines, { create, now: 10 + i * 3_600_000 }).woke.length;
    }
    expect(woken).toBe(MAX_ATTEMPTS);
    add(id, "Cilantro");
    const next = notes.noteSignature(id);
    expect(next).not.toBe(sig);
    expect(
      wakeForNote(id, acct, next, notes.noteLines(id), { create, now: 99e9 }).woke,
    ).toHaveLength(1);
  });
});

describe("which chats can do the edit", () => {
  const config = (computer_use: Record<string, unknown>) =>
    ConfigSchema.parse({
      self: { handles: [] },
      allowlist: { dm: [], groups: [] },
      identity: {},
      keys: { openrouter: "sk-or-test" },
      alerts: { operator_handle: "+15550100001" },
      security: { contact_tier: "operator" },
      computer_use,
    });

  test("while the check only shadows, only the owner's own chat", () => {
    const shadow = config({ enabled: true, classifier: "shadow", apps: ["Notes", "Freeform"] });
    expect(notes.canEditNotes(shadow, OWNER)).toBe(true);
    expect(notes.canEditNotes(shadow, PARTNER)).toBe(false);
    expect(notes.canEditNotes(shadow, GROUP)).toBe(false);
  });

  test("once it enforces, anyone whose app list has Notes", () => {
    const enforce = config({ enabled: true, apps: ["Notes"] });
    expect(notes.canEditNotes(enforce, PARTNER)).toBe(true);
    expect(notes.canEditNotes(enforce, GROUP)).toBe(true);
    const noNotes = config({ enabled: true, apps: ["Maps"], contact_apps: ["Maps"] });
    expect(notes.canEditNotes(noNotes, OWNER)).toBe(false);
    expect(notes.canEditNotes(noNotes, PARTNER)).toBe(false);
  });

  test("nobody, with computer use off or no config at all", () => {
    expect(notes.canEditNotes(config({ enabled: false, apps: ["Notes"] }), OWNER)).toBe(false);
    expect(notes.canEditNotes(null, OWNER)).toBe(false);
  });
});

describe("kitchen_shopping", () => {
  const tool = (sessionKey = OWNER) =>
    kitchenTools({
      sessionKey,
      config: { kitchen: { enabled: true, dir: BASE }, paths: { data_dir: BASE } },
    } as never).find((t) => t.name === "kitchen_shopping")!;
  const say = async (args: { account: string } & Record<string, unknown>) => {
    const r = await tool(members.get(args.account)).handler(args as never);
    return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  };

  test("no longer offers to push or share the note; it records that Edmund wrote it", () => {
    const shape = Object.keys((tool().inputSchema as unknown as { shape: object }).shape);
    expect(shape).toContain("noteWritten");
    for (const gone of ["notes", "share", "shareWith"]) expect(shape).not.toContain(gone);
  });

  test("says the note is behind, with the lines it should have, until noteWritten", async () => {
    const id = household();
    notes.noteDue(id);
    const out = await say({ account: id, add: [{ name: "Limes", amount: "4" }] });
    expect(out).toContain(`"${notes.noteTitle(id)}" is behind the list`);
    expect(out).toContain("[ ] Limes, 4");
    expect(await say({ account: id, noteWritten: true })).toContain("matches the list");
    expect(notes.noteBehind(id)).toBe(false);
    expect(await say({ account: id })).not.toContain("is behind the list");
  });
});
