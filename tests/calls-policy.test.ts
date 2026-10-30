/**
 * Who Edmund may call and whose calls he answers.
 */
import { describe, expect, test } from "bun:test";
import { CallPolicy, mayRequestCall } from "../src/calls/policy.ts";
import { type Config, ConfigSchema } from "../src/config/config.ts";
import { normalizeHandle } from "../src/sessions/key.ts";

const OPERATOR = "+15550100001";
const OPERATOR_EMAIL = "operator@example.com";
const FRIEND = "+15550100002";
const STRANGER = "+15550100003";
const GROUP = "any;+;chat123456";

function config(facetime: { allow?: string[]; deny?: string[] }): Config {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    security: { operator_handles: [OPERATOR] },
    facetime,
  });
}

/** The operator's phone and email are one person; FRIEND is in the address book. */
const contacts = {
  canon: (h: string) => (normalizeHandle(h) === OPERATOR_EMAIL ? OPERATOR : normalizeHandle(h)),
  displayName: (h: string) => {
    const c = normalizeHandle(h) === OPERATOR_EMAIL ? OPERATOR : normalizeHandle(h);
    return c === OPERATOR ? "Operator" : c === FRIEND ? "Friend" : null;
  },
};

const person = (handle: string) => ({ kind: "person" as const, handle });

describe("CallPolicy", () => {
  test("an empty allow list admits nobody", () => {
    const policy = new CallPolicy(config({}), contacts);
    expect(policy.permits(person(OPERATOR)).allowed).toBe(false);
    expect(policy.permits(person(FRIEND)).allowed).toBe(false);
  });

  test('"operator" admits the operator, by any of their handles, and nobody else', () => {
    const policy = new CallPolicy(config({ allow: ["operator"] }), contacts);
    expect(policy.permits(person(OPERATOR)).allowed).toBe(true);
    expect(policy.permits(person(OPERATOR_EMAIL)).allowed).toBe(true);
    expect(policy.permits(person(FRIEND)).allowed).toBe(false);
  });

  test('"contacts" admits anyone his contacts name, and no stranger', () => {
    const policy = new CallPolicy(config({ allow: ["contacts"] }), contacts);
    expect(policy.permits(person(FRIEND)).allowed).toBe(true);
    expect(policy.permits(person(STRANGER)).allowed).toBe(false);
  });

  test("deny wins over allow", () => {
    const policy = new CallPolicy(config({ allow: ["contacts"], deny: [FRIEND] }), contacts);
    expect(policy.permits(person(FRIEND))).toEqual({ allowed: false, reason: "person is denied" });
    expect(policy.permits(person(OPERATOR)).allowed).toBe(true);
  });

  test("an explicit handle is matched canonically", () => {
    const policy = new CallPolicy(
      config({ allow: ["(555) 010-0002".replace("(555)", "+1555")] }),
      contacts,
    );
    expect(policy.permits(person(FRIEND)).allowed).toBe(true);
  });

  test("a group is admitted only by its own chat GUID", () => {
    const policy = new CallPolicy(config({ allow: ["contacts", GROUP] }), contacts);
    expect(policy.permits({ kind: "group", chatGuid: GROUP }).allowed).toBe(true);
    expect(policy.permits({ kind: "group", chatGuid: "any;+;chat999" }).allowed).toBe(false);
  });
});

describe("mayRequestCall", () => {
  const cfg = config({ allow: ["contacts"] });
  const operatorDm = `imessage:dm:${OPERATOR}`;
  const friendDm = `imessage:dm:${FRIEND}`;

  test("anyone may ask Edmund to call them", () => {
    expect(mayRequestCall(cfg, friendDm, friendDm).allowed).toBe(true);
  });

  test("asking him to call someone else takes the operator", () => {
    expect(mayRequestCall(cfg, operatorDm, friendDm).allowed).toBe(true);
    expect(mayRequestCall(cfg, friendDm, operatorDm).allowed).toBe(false);
  });
});
