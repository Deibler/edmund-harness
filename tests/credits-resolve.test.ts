import { describe, expect, test } from "bun:test";
import { resolveBillingSession, walletSessionKeyFor } from "../src/credits/resolve.ts";
import type { BillingMode } from "../src/credits/store.ts";

const OPERATOR = "+15550100001";

function deps(
  over: {
    modes?: Record<string, BillingMode>;
    parents?: Record<string, string>;
    operator?: string;
  } = {},
) {
  return {
    operatorHandle: over.operator ?? OPERATOR,
    modeOf: (k: string) => over.modes?.[k] ?? null,
    parentOf: (id: string) => over.parents?.[id] ?? null,
  };
}

describe("resolveBillingSession", () => {
  test("a DM bills to that person's wallet, keyed by the iMessage DM form", () => {
    const r = resolveBillingSession("imessage:dm:+15550100005", deps());
    expect(r).toEqual({
      kind: "wallet",
      sessionKey: "imessage:dm:+15550100005",
      handle: "+15550100005",
    });
  });

  test("an SMS DM from the same handle shares the iMessage wallet", () => {
    const sms = resolveBillingSession("sms:dm:+15550100005", deps());
    const im = resolveBillingSession("imessage:dm:+15550100005", deps());
    expect(sms).toEqual(im);
  });

  test("handle spelling does not split a wallet: type prefix, case, punctuation", () => {
    expect(walletSessionKeyFor("e:Pat@Example.com")).toBe("imessage:dm:pat@example.com");
    expect(walletSessionKeyFor("(555) 010-0005")).toBe("imessage:dm:5550100005");
    expect(walletSessionKeyFor("p:+1 555 010 0005")).toBe("imessage:dm:+15550100005");
  });

  test("the operator's own DM is house, however the handle is spelled", () => {
    expect(resolveBillingSession(`imessage:dm:${OPERATOR}`, deps())).toEqual({
      kind: "house",
      reason: "operator",
    });
    expect(resolveBillingSession("imessage:dm:p:+1 (555) 010-0001", deps())).toEqual({
      kind: "house",
      reason: "operator",
    });
  });

  test("the operator can opt INTO a wallet with an explicit wallet row, and back out", () => {
    const key = `imessage:dm:${OPERATOR}`;
    expect(resolveBillingSession(key, deps({ modes: { [key]: "wallet" } }))).toEqual({
      kind: "wallet",
      sessionKey: key,
      handle: OPERATOR,
    });
    expect(resolveBillingSession(key, deps({ modes: { [key]: "house" } }))).toEqual({
      kind: "house",
      reason: "operator",
    });
  });

  test("an empty operator handle exempts nobody", () => {
    const r = resolveBillingSession(`imessage:dm:${OPERATOR}`, deps({ operator: "" }));
    expect(r.kind).toBe("wallet");
  });

  test("the per-person override sends a DM to house", () => {
    const r = resolveBillingSession(
      "imessage:dm:+15550100005",
      deps({ modes: { "imessage:dm:+15550100005": "house" } }),
    );
    expect(r).toEqual({ kind: "house", reason: "override" });
  });

  test("an override set to wallet is the default and changes nothing", () => {
    const r = resolveBillingSession(
      "imessage:dm:+15550100005",
      deps({ modes: { "imessage:dm:+15550100005": "wallet" } }),
    );
    expect(r.kind).toBe("wallet");
  });

  test("groups, mirror, orchestrators, trading and unknown keys are house", () => {
    for (const k of [
      "imessage:group:any;chat123",
      "sms:group:CH123",
      "mirror:pi-4",
      "orch:desmond:dm:+15550100005",
      "trading:dm:+15550100005",
      "cron:whatever",
    ]) {
      expect(resolveBillingSession(k, deps())).toEqual({
        kind: "house",
        reason: "group-or-system",
      });
    }
  });

  test("a spawned agent bills to whatever its parent resolves to", () => {
    const parents = { agent_1: "imessage:dm:+15550100005", agent_2: "imessage:group:g1" };
    expect(resolveBillingSession("agent:agent_1", deps({ parents }))).toEqual({
      kind: "wallet",
      sessionKey: "imessage:dm:+15550100005",
      handle: "+15550100005",
    });
    expect(resolveBillingSession("agent:agent_2", deps({ parents }))).toEqual({
      kind: "house",
      reason: "group-or-system",
    });
  });

  test("an agent with no recorded parent is house, never a guess", () => {
    expect(resolveBillingSession("agent:agent_lost", deps())).toEqual({
      kind: "house",
      reason: "agent-without-parent",
    });
  });

  test("an agent chain is followed, and a runaway chain stops at house", () => {
    const parents = { a: "agent:b", b: "agent:c", c: "imessage:dm:+1555" };
    expect(resolveBillingSession("agent:a", deps({ parents })).kind).toBe("wallet");
    const loop = { a: "agent:b", b: "agent:a" };
    expect(resolveBillingSession("agent:a", deps({ parents: loop }))).toEqual({
      kind: "house",
      reason: "agent-depth",
    });
  });
});
