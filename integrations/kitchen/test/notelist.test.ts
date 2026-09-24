/**
 * The shared note, now that only Edmund writes it, on screen.
 *
 * Nothing here touches a note. What is pinned is the decision around it: what
 * the note should say, which of its lines Edmund may delete, when a changed
 * list is worth waking a session for, that a wake happens once per list
 * rather than every ten seconds, that a chat with no screen tools for Notes
 * (or a locked Mac) is never woken to do an edit it cannot make, and that a
 * confirmation records what Edmund was shown.
 *
 * Runs against a scratch KITCHEN_DIR.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../../src/config/config.ts";
import type { JobInput } from "../../../src/cron/types.ts";
import { HARMS } from "../../../src/mcp/computer-use/guard.ts";
import { zodToJsonSchema } from "../../../src/mcp/zod-to-json.ts";

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

const { accountDir, createAccount, getAccount, joinAccount, updateAccount } = await import(
  "../src/accounts.ts"
);
const { addToList, removeFromList } = await import("../src/list.ts");
const notes = await import("../src/notelist.ts");
const { MAX_ATTEMPTS, RETRY_MS, noteEventText, wakeForNote } = await import("../src/wake.ts");
const { noteStep } = await import("../src/notewatch.ts");
const { drain } = await import("../src/drain.ts");
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

/** Edmund is shown the note and confirms exactly what he was shown. */
function writeNote(id: string, now = Date.now()) {
  const brief = notes.showNote(id, now);
  const r = notes.markNoteWritten(id, brief.version, now);
  expect(r.ok).toBe(true);
  return brief;
}

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

describe("whose lines Edmund may delete", () => {
  test("only his own recorded lines that left the list; a line somebody typed between them is never named", () => {
    const id = household();
    notes.noteDue(id);
    add(id, "Limes");
    add(id, "Milk");
    writeNote(id);
    // The limes were bought. Meanwhile somebody typed "Birthday candles"
    // between "Limes" and "Milk", and reworded "Milk": neither is a line the
    // kitchen wrote, so neither may be named for deletion.
    removeFromList(id, ["limes"]);
    const brief = notes.showNote(id);
    expect(brief.gone).toEqual(["Limes"]);
    const event = noteEventText(id, getAccount(id)!, brief);
    expect(event).toContain(
      `${notes.OWN_LINES}. These are the only lines above the sentinel you may delete:\n  Limes\n`,
    );
    expect(event).toContain(notes.THEIRS_ABOVE);
    expect(event).not.toContain("delete lines no longer on the list");
  });

  test("the record is what he wrote: a line still on the list is never named, whatever the note shows", () => {
    const id = household();
    notes.noteDue(id);
    add(id, "Milk");
    writeNote(id);
    add(id, "Cilantro");
    expect(notes.showNote(id).gone).toEqual([]);
    expect(notes.ownLinesText([])).toContain("delete nothing above the sentinel");
  });

  test("with no record at all, he may delete nothing above the sentinel, and the event says so", () => {
    const id = household();
    // Behind before anything recorded whose lines are whose.
    writeFileSync(
      notes.notePath(id),
      JSON.stringify({ written: "0000000000000000", seen: "0000000000000000" }),
    );
    add(id, "Limes");
    const brief = notes.showNote(id);
    expect(brief.gone).toBeNull();
    const event = noteEventText(id, getAccount(id)!, brief);
    expect(event).not.toContain(notes.OWN_LINES);
    expect(event).toContain("delete none of them");
    expect(event).toContain("leave every line that is not in the list where it is");
  });

  test("the old browser sync's record is used until the note has one of its own", () => {
    const id = household();
    writeFileSync(
      notes.notePath(id),
      JSON.stringify({ written: "0000000000000000", seen: "0000000000000000" }),
    );
    mkdirSync(join(accountDir(), id), { recursive: true });
    writeFileSync(
      join(accountDir(), id, "notes.json"),
      JSON.stringify({ version: 1, ourLines: ["limes", "eggs, 12"] }),
    );
    add(id, "Eggs", "12");
    expect(notes.showNote(id).gone).toEqual(["limes"]);
    // An empty record meant "none" there too.
    writeFileSync(join(accountDir(), id, "notes.json"), JSON.stringify({ ourLines: [] }));
    expect(notes.showNote(id).gone).toBeNull();
  });

  test("a note believed current records the kitchen's lines as his, once", () => {
    const id = household();
    add(id, "Limes");
    mkdirSync(join(accountDir(), id), { recursive: true });
    writeFileSync(
      join(accountDir(), id, "notes.json"),
      JSON.stringify({ ourLines: ["limes", "old bread"] }),
    );
    notes.noteDue(id); // first seen: the old sync kept it current
    // Both records, once each, in the list's own wording where they overlap.
    expect(notes.readNoteState(id).lines).toContain("Limes");
    expect(notes.readNoteState(id).lines).toContain("old bread");
    expect(notes.readNoteState(id).lines).not.toContain("limes");
    removeFromList(id, ["limes"]);
    expect(notes.showNote(id).gone).toEqual(expect.arrayContaining(["Limes", "old bread"]));
  });

  test("the screen check allows a deletion only for lines the event lists as his own", () => {
    const q = HARMS.destructive.question;
    // The words the event lists his lines under are the words the check keys on.
    expect(q).toContain(`"${notes.OWN_LINES}"`);
    expect(q).toContain("Deleting any other line above that note's sentinel is destruction");
    // The old permission (anything not in the list may go) is gone.
    expect(q).not.toContain("not one of those lines");
  });

  test("a big list still puts his named lines inside what the screen check reads", () => {
    const id = household();
    notes.noteDue(id);
    for (let i = 0; i < 30; i++) add(id, `Pantry thing number ${i}`, "2 jars");
    writeNote(id);
    for (let i = 0; i < 10; i++) removeFromList(id, [`pantry-thing-number-${i}`]);
    for (let i = 0; i < 10; i++) add(id, `Fresh thing number ${i}`, "1 bunch");
    const event = noteEventText(id, getAccount(id)!, notes.showNote(id));
    // request.ts gives the check the first 4,000 characters of the event.
    const seen = event.slice(0, 4000);
    expect(event.length).toBeLessThanOrEqual(4000);
    for (let i = 0; i < 10; i++) expect(seen).toContain(`  Pantry thing number ${i}, 2 jars\n`);
    expect(seen.indexOf(notes.OWN_LINES)).toBeLessThan(seen.indexOf("the note should read"));
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
    writeNote(id, T + 1_000);
    expect(notes.noteBehind(id)).toBe(false);
    expect(notes.noteDue(id, T + 10 * notes.SETTLE_MS).due).toBe(false);
    add(id, "Cilantro");
    expect(notes.noteBehind(id)).toBe(true);
  });

  test("a confirmed note keeps its title when somebody in the household is named", () => {
    const id = household();
    updateAccount(id, { people: { [members.get(id)!]: "Sam" } });
    writeNote(id, T);
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
    notes.requestNoteUpdate(id, T);
    expect(notes.noteDue(id, T).due).toBe(true);
    writeNote(id, T);
    expect(notes.noteDue(id, T).due).toBe(false);
  });

  test("a site request stored the old way is still a request", () => {
    const id = household();
    writeFileSync(
      notes.notePath(id),
      JSON.stringify({ written: "requested", seen: "0000000000000000", seenSince: null }),
    );
    expect(notes.readNoteState(id).requested).not.toBeNull();
    expect(notes.noteDue(id, T)).toMatchObject({ due: true, requested: true });
  });

  test("a list that cannot be woken for is reported once, not every pass", () => {
    const id = household();
    expect(notes.holdNote(id, "abc")).toBe(true);
    expect(notes.holdNote(id, "abc")).toBe(false);
    expect(notes.holdNote(id, "def")).toBe(true);
  });
});

describe("what a confirmation records", () => {
  test("the version Edmund was shown, not the list as it is by the time he confirms", () => {
    const id = household();
    notes.noteDue(id);
    add(id, "Limes");
    const shown = notes.showNote(id);
    // A site tap adds cilantro while he is editing.
    add(id, "Cilantro");
    const r = notes.markNoteWritten(id, shown.version);
    expect(r).toEqual({ ok: true, version: shown.version, current: false });
    expect(notes.readNoteState(id).lines).toContain("Limes");
    expect(notes.readNoteState(id).lines).not.toContain("Cilantro");
    // So the note is still behind, and becomes due once the change settles.
    expect(notes.noteBehind(id)).toBe(true);
    const t = Date.now();
    notes.noteDue(id, t);
    expect(notes.noteDue(id, t + notes.SETTLE_MS).due).toBe(true);
  });

  test("a version he was never shown records nothing", () => {
    const id = household();
    notes.noteDue(id);
    add(id, "Limes");
    const before = notes.readNoteState(id);
    expect(notes.markNoteWritten(id, "ffffffffffffffff").ok).toBe(false);
    expect(notes.readNoteState(id)).toEqual(before);
    expect(notes.noteBehind(id)).toBe(true);
  });
});

describe("the wake", () => {
  const jobs: JobInput[] = [];
  const create = (i: JobInput) => {
    jobs.push(i);
    return { id: `j${jobs.length}` };
  };

  test("goes to the household's session with the lines, their version, the note's title and how to edit it", () => {
    const id = household();
    add(id, "Limes", "4");
    const acct = getAccount(id)!;
    const sig = notes.noteSignature(id);
    const w = wakeForNote(id, acct, sig, { create, now: 1 });
    expect(w.woke.map((x) => [x.session, x.keys])).toEqual([[members.get(id)!, [`note:${sig}`]]]);
    const event = jobs.at(-1)!.systemEvent!;
    expect(event).toContain(`"${notes.noteTitle(id)}"`);
    expect(event).toContain("[ ] Limes, 4");
    expect(event).toContain(notes.SENTINEL);
    expect(event).toContain("Never select all and paste");
    expect(event).toContain(`noteWritten:true noteVersion:"${sig}"`);
    expect(event).toContain("KEEP_QUIET");
    // The version it names is one a confirmation can record.
    add(id, "Cilantro");
    expect(notes.markNoteWritten(id, sig).ok).toBe(true);
  });

  test("one list wakes at most a few times; a new list is a new wake", () => {
    const id = household();
    add(id, "Limes");
    const acct = getAccount(id)!;
    const sig = notes.noteSignature(id);
    let woken = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      woken += wakeForNote(id, acct, sig, { create, now: 10 + i * 3_600_000 }).woke.length;
    }
    expect(woken).toBe(MAX_ATTEMPTS);
    add(id, "Cilantro");
    const next = notes.noteSignature(id);
    expect(next).not.toBe(sig);
    expect(wakeForNote(id, acct, next, { create, now: 99e9 }).woke).toHaveLength(1);
  });
});

describe("the watch pass's note step", () => {
  const T = Date.parse("2026-09-24T12:00:00Z");
  const withNotes = config({ enabled: true, apps: ["Notes"] });
  const noNotes = config({ enabled: true, apps: ["Maps"], contact_apps: ["Maps"] });
  const unlocked = async () => false;

  /** A household whose note is due: its list changed and has settled. */
  function due(): string {
    const id = household();
    notes.noteDue(id, T);
    add(id, `Limes ${n}`);
    notes.noteDue(id, T);
    return id;
  }
  const step = (
    id: string,
    now: number,
    opts: { locked?: () => Promise<boolean>; cfg?: typeof withNotes } = {},
  ) => {
    const jobs: JobInput[] = [];
    const run = noteStep(id, getAccount(id)!, opts.cfg ?? withNotes, {
      locked: opts.locked ?? unlocked,
      now,
      create: (i) => {
        jobs.push(i);
        return { id: `j${jobs.length}` };
      },
    });
    return run.then((log) => ({ log, jobs }));
  };
  const settled = T + notes.SETTLE_MS;

  test("wakes the household's session once its note is due", async () => {
    const id = due();
    expect((await step(id, T + 1_000)).jobs).toHaveLength(0);
    const { log, jobs } = await step(id, settled);
    expect(jobs.map((j) => j.sessionKey)).toEqual([members.get(id)!]);
    expect(log.join("\n")).toContain("woke");
  });

  test("a chat the screen policy gives no Notes is never woken, and that is said once", async () => {
    const id = due();
    const first = await step(id, settled, { cfg: noNotes });
    expect(first.jobs).toHaveLength(0);
    expect(first.log.join("\n")).toContain("has no screen tools for Notes");
    expect((await step(id, settled + 10_000, { cfg: noNotes })).log).toEqual([]);
  });

  test("a locked Mac spends no wake; the note is woken for once it is unlocked", async () => {
    const id = due();
    let asked = 0;
    const locked = async () => {
      asked++;
      return true;
    };
    let said = 0;
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      const r = await step(id, settled + i * (RETRY_MS + 1), { locked });
      expect(r.jobs).toHaveLength(0);
      said += r.log.length;
    }
    expect(asked).toBe(MAX_ATTEMPTS + 2);
    expect(said).toBe(1);
    const later = settled + (MAX_ATTEMPTS + 2) * (RETRY_MS + 1);
    expect((await step(id, later)).jobs).toHaveLength(1);
  });

  test("a lock check that fails wakes nothing", async () => {
    const id = due();
    const r = await step(id, settled, {
      locked: async () => {
        throw new Error("the screen helper exited");
      },
    });
    expect(r.jobs).toHaveLength(0);
    expect(r.log.join("\n")).toContain("could not be read");
  });

  test("the screen is not looked at while no wake could go out", async () => {
    const id = due();
    let asked = 0;
    const locked = async () => {
      asked++;
      return false;
    };
    await step(id, T + 1_000, { locked }); // not settled
    expect(asked).toBe(0);
    await step(id, settled, { locked }); // woken
    await step(id, settled + 60_000, { locked }); // held: recent
    expect(asked).toBe(1);
  });

  test("somebody asking from the site gets a new wake after the list's attempts ran out", async () => {
    const id = due();
    for (let i = 0; i < MAX_ATTEMPTS; i++)
      expect((await step(id, settled + i * (RETRY_MS + 1))).jobs).toHaveLength(1);
    const after = settled + MAX_ATTEMPTS * (RETRY_MS + 1);
    const spent = await step(id, after);
    expect(spent.jobs).toHaveLength(0);
    expect(spent.log.join("\n")).toContain(`after ${MAX_ATTEMPTS} wakes`);
    notes.requestNoteUpdate(id, after);
    const asked = await step(id, after + 1_000);
    expect(asked.jobs).toHaveLength(1);
    expect(asked.log.join("\n")).toContain("asked for from the site");
  });

  test("a request makes the note due once; later changes settle as usual", async () => {
    const id = household();
    notes.noteDue(id, T);
    notes.requestNoteUpdate(id, T);
    expect((await step(id, T + 1_000)).jobs).toHaveLength(1);
    // A burst of taps on the site after the wake: each is not its own turn.
    add(id, "Limes");
    expect((await step(id, T + RETRY_MS + 2_000)).jobs).toHaveLength(0);
    add(id, "Cilantro");
    expect((await step(id, T + RETRY_MS + 3_000)).jobs).toHaveLength(0);
    expect((await step(id, T + RETRY_MS + 3_000 + notes.SETTLE_MS)).jobs).toHaveLength(1);
  });

  test("the site's Apple Notes button, through the drain, asks for a wake", async () => {
    const id = household();
    const site = mkdtempSync(join(tmpdir(), "kitchen-notelist-site-"));
    updateAccount(id, { site: { artifact: site, url: null } });
    notes.noteDue(id, T);
    appendFileSync(
      join(site, "_callbacks.jsonl"),
      `${JSON.stringify({ ts: "2026-09-24T12:00:00.000Z", kind: "notes", profile: members.get(id) })}\n`,
    );
    const res = await drain(id);
    expect(res.done.join("\n")).toContain("apple notes");
    expect((await step(id, T + 1_000)).jobs).toHaveLength(1);
    rmSync(site, { recursive: true, force: true });
  });
});

describe("which chats can do the edit", () => {
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

  test("Notes named any way the screen server accepts it", () => {
    for (const entry of ["Notes.app", "com.apple.Notes", " notes "]) {
      const c = config({ enabled: true, apps: [entry], contact_apps: [entry] });
      expect(notes.canEditNotes(c, OWNER)).toBe(true);
      expect(notes.canEditNotes(c, PARTNER)).toBe(true);
    }
    const notesy = config({ enabled: true, apps: ["Notes Helper"], contact_apps: ["Notebook"] });
    expect(notes.canEditNotes(notesy, OWNER)).toBe(false);
    expect(notes.canEditNotes(notesy, PARTNER)).toBe(false);
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
  const versionIn = (out: string) => /\(version ([0-9a-f]{16})\)/.exec(out)?.[1];

  test("no longer offers to push or share the note; it records the version Edmund wrote", () => {
    const shape = Object.keys((tool().inputSchema as unknown as { shape: object }).shape);
    expect(shape).toContain("noteWritten");
    expect(shape).toContain("noteVersion");
    for (const gone of ["notes", "share", "shareWith"]) expect(shape).not.toContain(gone);
    // Published, not an empty schema the model would have to guess at.
    const published = zodToJsonSchema(tool().inputSchema, "kitchen_shopping");
    expect(published.properties.noteVersion).toMatchObject({ type: "string" });
    expect(published.properties.noteWritten).toMatchObject({ type: "boolean" });
  });

  test("says the note is behind, with the lines and their version, until noteWritten names it", async () => {
    const id = household();
    notes.noteDue(id);
    const out = await say({ account: id, add: [{ name: "Limes", amount: "4" }] });
    expect(out).toContain(`"${notes.noteTitle(id)}" is behind the list`);
    expect(out).toContain("[ ] Limes, 4");
    const version = versionIn(out);
    expect(version).toBe(notes.noteSignature(id));

    // Without the version, nothing is recorded.
    const bare = await say({ account: id, noteWritten: true });
    expect(bare).toContain("Nothing recorded for the note");
    expect(notes.noteBehind(id)).toBe(true);

    expect(await say({ account: id, noteWritten: true, noteVersion: version })).toContain(
      `matches version ${version}`,
    );
    expect(notes.noteBehind(id)).toBe(false);
    expect(await say({ account: id })).not.toContain("is behind the list");
  });

  test("a confirmation of a version the list has since left says the note is behind again", async () => {
    const id = household();
    notes.noteDue(id);
    const version = versionIn(await say({ account: id, add: [{ name: "Limes" }] }));
    add(id, "Cilantro");
    const out = await say({ account: id, noteWritten: true, noteVersion: version });
    expect(out).toContain(`matches version ${version}`);
    expect(out).toContain("is behind the list again");
    expect(out).toContain("[ ] Cilantro");
    expect(notes.noteBehind(id)).toBe(true);
  });
});
