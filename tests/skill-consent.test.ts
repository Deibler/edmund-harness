import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatDb } from "../src/imessage/db.ts";
import { ContactBook } from "../src/sessions/contacts.ts";
import {
  type ConsentDeps,
  consentState,
  readConsentDb,
  recordDecision,
  revokeConsentFor,
  serveAsk,
} from "../src/skills/consent.ts";
import type { InstallRecord } from "../src/skills/installer.ts";
import { GROUP_BLURB, SKILL_GROUPS, skillGroupOf } from "../src/skills/provenance.ts";

/**
 * The consent gate for published skills.
 *
 * The operator's rule, in their words: when someone else's published skill
 * comes up, confirm the first time — and in a group, only if the person who
 * wrote it is NOT in the room. Both halves are tested here, and so is the
 * thing that makes the gate real rather than polite: a consent that cannot be
 * granted without a human having spoken.
 */

const KAYLA = "+15550001111";
const AUSTIN = "+15550002222";
const STRANGER = "+15550003333";

const GROUP_WITH_KAYLA = "iMessage;+;chat-with-kayla";
const GROUP_WITHOUT_KAYLA = "iMessage;+;chat-without-kayla";

/** Minimal chat.db stand-in: participants per chat GUID, nothing else. */
function fakeChatDb(members: Record<string, string[]>): ChatDb {
  return {
    query: () => ({
      all: (guid: string) => (members[guid] ?? []).map((handle) => ({ handle })),
      get: () => undefined,
    }),
  } as unknown as ChatDb;
}

function publicSkill(overrides: Partial<InstallRecord> = {}): InstallRecord {
  return {
    name: "race-day-plan",
    source: "self-authored",
    version: null,
    sha: "x",
    installed_at: 1,
    needs_approval: false,
    approved_at: null,
    has_scripts: false,
    disabled: false,
    category: "public",
    publisher: KAYLA,
    publisher_name: "Sam",
    origin_scope: `imessage:dm:${KAYLA}`,
    scope: null,
    ...overrides,
  };
}

let dir: string;
let deps: (sessionChatGuids?: string[]) => ConsentDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "consent-"));
  const contacts = new ContactBook([
    { name: "Sam", handles: [KAYLA] },
    { name: "Jordan", handles: [AUSTIN] },
  ]);
  const chatDb = fakeChatDb({
    [GROUP_WITH_KAYLA]: [AUSTIN, KAYLA, STRANGER],
    [GROUP_WITHOUT_KAYLA]: [AUSTIN, STRANGER],
  });
  deps = (chatGuids = []) => ({
    chatDb,
    contacts,
    chatGuids,
    consentDbPath: join(dir, "consent.json"),
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("who has to be asked", () => {
  test("a curated skill is never gated — there is nobody to ask", () => {
    const curated = publicSkill({ category: "curated", publisher: null, publisher_name: null });
    expect(consentState(curated, `imessage:dm:${STRANGER}`, deps()).required).toBe(false);
  });

  test("a marketplace or self-authored skill is never gated", () => {
    for (const category of ["self", "marketplace"] as const) {
      const rec = publicSkill({ category, publisher: null });
      expect(consentState(rec, `imessage:dm:${STRANGER}`, deps()).required).toBe(false);
    }
  });

  test("a stranger using Sam's published skill must be asked, and the ask names her", () => {
    const state = consentState(publicSkill(), `imessage:dm:${STRANGER}`, deps());
    expect(state.required).toBe(true);
    if (!state.required) throw new Error("unreachable");
    expect(state.publisherName).toBe("Sam");
    expect(state.reason).toBe("never-asked");
  });

  test("Sam is not asked about her own skill", () => {
    expect(consentState(publicSkill(), `imessage:dm:${KAYLA}`, deps()).required).toBe(false);
  });

  test("in a group Sam is in, nobody is asked — she is right there", () => {
    const state = consentState(
      publicSkill(),
      `imessage:group:${GROUP_WITH_KAYLA}`,
      deps([GROUP_WITH_KAYLA]),
    );
    expect(state.required).toBe(false);
    if (state.required) throw new Error("unreachable");
    expect(state.reason).toBe("publisher-present");
  });

  test("in a group Sam is NOT in, the room is asked once", () => {
    const state = consentState(
      publicSkill(),
      `imessage:group:${GROUP_WITHOUT_KAYLA}`,
      deps([GROUP_WITHOUT_KAYLA]),
    );
    expect(state.required).toBe(true);
  });

  test("the group rule reads live membership — a publisher who left is asked about again", () => {
    // Same skill, same room, one roster change. If membership were cached at
    // any layer this would keep answering "she's here".
    const before = consentState(
      publicSkill(),
      `imessage:group:${GROUP_WITH_KAYLA}`,
      deps([GROUP_WITH_KAYLA]),
    );
    const afterLeaving = consentState(publicSkill(), `imessage:group:${GROUP_WITH_KAYLA}`, {
      ...deps([GROUP_WITH_KAYLA]),
      chatDb: fakeChatDb({ [GROUP_WITH_KAYLA]: [AUSTIN, STRANGER] }),
    });
    expect(before.required).toBe(false);
    expect(afterLeaving.required).toBe(true);
  });
});

describe("recording the answer", () => {
  const session = `imessage:dm:${STRANGER}`;

  test("an answer with no question is refused", () => {
    const result = recordDecision({
      skillName: "race-day-plan",
      sessionKey: session,
      decision: "allow",
      lastInboundMs: Date.now(),
      consentDbPath: join(dir, "consent.json"),
    });
    expect(result.ok).toBe(false);
  });

  test("a yes nobody said is refused — the inbound must postdate the ask", () => {
    const d = deps();
    const state = consentState(publicSkill(), session, d);
    if (!state.required) throw new Error("expected a gated skill");
    serveAsk(publicSkill(), session, state, d);

    // This is the whole invariant: the model has just asked, inside this turn,
    // and the last thing the person said was BEFORE the question. Answering
    // for them here is what the check exists to stop.
    const result = recordDecision({
      skillName: "race-day-plan",
      sessionKey: session,
      decision: "allow",
      lastInboundMs: Date.now() - 60_000,
      consentDbPath: d.consentDbPath,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("have not answered");

    // And the gate is still shut afterwards.
    expect(consentState(publicSkill(), session, d).required).toBe(true);
  });

  test("no session row at all fails closed", () => {
    const d = deps();
    const state = consentState(publicSkill(), session, d);
    if (!state.required) throw new Error("expected a gated skill");
    serveAsk(publicSkill(), session, state, d);
    const result = recordDecision({
      skillName: "race-day-plan",
      sessionKey: session,
      decision: "allow",
      lastInboundMs: null,
      consentDbPath: d.consentDbPath,
    });
    expect(result.ok).toBe(false);
  });

  test("a real yes opens it, permanently, for this chat only", () => {
    const d = deps();
    const state = consentState(publicSkill(), session, d);
    if (!state.required) throw new Error("expected a gated skill");
    serveAsk(publicSkill(), session, state, d);

    const result = recordDecision({
      skillName: "race-day-plan",
      sessionKey: session,
      decision: "allow",
      lastInboundMs: Date.now() + 1_000,
      consentDbPath: d.consentDbPath,
    });
    expect(result.ok).toBe(true);
    expect(consentState(publicSkill(), session, d).required).toBe(false);
    // Another conversation inherits nothing.
    expect(consentState(publicSkill(), `imessage:dm:${AUSTIN}`, d).required).toBe(true);
  });

  test("a no keeps it shut and says so, so a retry is not a fresh ask", () => {
    const d = deps();
    const first = consentState(publicSkill(), session, d);
    if (!first.required) throw new Error("expected a gated skill");
    serveAsk(publicSkill(), session, first, d);
    recordDecision({
      skillName: "race-day-plan",
      sessionKey: session,
      decision: "deny",
      lastInboundMs: Date.now() + 1_000,
      consentDbPath: d.consentDbPath,
    });

    const second = consentState(publicSkill(), session, d);
    expect(second.required).toBe(true);
    if (!second.required) throw new Error("unreachable");
    expect(second.reason).toBe("previously-declined");
    expect(serveAsk(publicSkill(), session, second, d)).toContain("declined this once before");
  });

  test("the ask is spent once answered — a stale yes cannot be replayed", () => {
    const d = deps();
    const state = consentState(publicSkill(), session, d);
    if (!state.required) throw new Error("expected a gated skill");
    serveAsk(publicSkill(), session, state, d);
    const at = Date.now() + 1_000;
    recordDecision({
      skillName: "race-day-plan",
      sessionKey: session,
      decision: "deny",
      lastInboundMs: at,
      consentDbPath: d.consentDbPath,
    });
    // No fresh ask served, so this second answer has nothing to answer.
    const replay = recordDecision({
      skillName: "race-day-plan",
      sessionKey: session,
      decision: "allow",
      lastInboundMs: at + 1_000,
      consentDbPath: d.consentDbPath,
    });
    expect(replay.ok).toBe(false);
    expect(readConsentDb(d.consentDbPath).decisions[`race-day-plan|${session}`]?.decision).toBe(
      "deny",
    );
  });

  test("revoking clears every chat's answer — for an unpublish or an edit", () => {
    const d = deps();
    for (const s of [session, `imessage:dm:${AUSTIN}`]) {
      const state = consentState(publicSkill(), s, d);
      if (!state.required) throw new Error("expected a gated skill");
      serveAsk(publicSkill(), s, state, d);
      recordDecision({
        skillName: "race-day-plan",
        sessionKey: s,
        decision: "allow",
        lastInboundMs: Date.now() + 1_000,
        consentDbPath: d.consentDbPath,
      });
    }
    revokeConsentFor("race-day-plan", d.consentDbPath);
    expect(consentState(publicSkill(), session, d).required).toBe(true);
    expect(consentState(publicSkill(), `imessage:dm:${AUSTIN}`, d).required).toBe(true);
  });
});

describe("the ask itself", () => {
  test("names the publisher and forbids describing what was not read", () => {
    const d = deps();
    const session = `imessage:dm:${STRANGER}`;
    const state = consentState(publicSkill(), session, d);
    if (!state.required) throw new Error("expected a gated skill");
    const stub = serveAsk(publicSkill(), session, state, d);
    expect(stub).toContain("Sam");
    expect(stub).toContain("NOT loaded");
    expect(stub).toContain("Do not describe what the skill does");
    // The stub must never carry the instructions it is standing in for.
    expect(stub).not.toContain("race-day-plan is a skill that");
  });
});

describe("provenance — one classifier, two surfaces", () => {
  const KAYLAS_DM = `imessage:dm:${KAYLA}`;

  test("the same published skill is 'yours' to its author and 'public' to everyone else", () => {
    // The asymmetry is the whole point: it decides whether a consent ask is
    // coming, and whether update_skill/publish_skill may touch it.
    const rec = publicSkill();
    expect(skillGroupOf(rec, KAYLAS_DM)).toBe("yours");
    expect(skillGroupOf(rec, `imessage:dm:${STRANGER}`)).toBe("public");
  });

  test("a curated skill is curated for everyone — nobody owns it", () => {
    const rec = publicSkill({ category: "curated", origin_scope: null, publisher: null });
    expect(skillGroupOf(rec, KAYLAS_DM)).toBe("curated");
    expect(skillGroupOf(rec, `imessage:dm:${STRANGER}`)).toBe("curated");
  });

  test("a chat's own private skill is theirs, and invisible-as-yours elsewhere", () => {
    const rec = publicSkill({ category: "self", scope: KAYLAS_DM, origin_scope: KAYLAS_DM });
    expect(skillGroupOf(rec, KAYLAS_DM)).toBe("yours");
    expect(skillGroupOf(rec, `imessage:dm:${STRANGER}`)).toBe("system");
  });

  test("a pre-shipped skill with no record at all is system", () => {
    expect(skillGroupOf(undefined, KAYLAS_DM)).toBe("system");
  });

  test("every group has a blurb the model is given", () => {
    for (const g of SKILL_GROUPS) expect(GROUP_BLURB[g].length).toBeGreaterThan(10);
  });
});
