/**
 * Freeing a busy conversation for a ringing call without losing its work.
 */
import { describe, expect, test } from "bun:test";
import { type TakeoverDeps, clearForCall, handoffNotice } from "../src/calls/takeover.ts";

const KEY = "imessage:dm:+15550100001";

function fakeDeps(opts: {
  busy: boolean;
  /** The running turn hands off on its own after this many polls. */
  letsGoAfterPolls?: number;
  /** Agents the model spawns itself when it hands off. */
  modelHandsOff?: boolean;
  request?: string | null;
}) {
  let clock = 1_000;
  let busy = opts.busy;
  let polls = 0;
  const injected: string[] = [];
  const interrupted: string[] = [];
  const spawned: string[] = [];
  const agents: { id: string; at: number }[] = [];
  const deps: TakeoverDeps = {
    isBusy: () => busy,
    inject: (_key, text) => {
      injected.push(text);
      return true;
    },
    interrupt: (_key, reason) => {
      interrupted.push(reason);
      busy = false;
      return true;
    },
    inFlightRequest: () =>
      opts.request === undefined ? "find me flights to Denver" : opts.request,
    spawnHandoff: (_key, task) => {
      spawned.push(task);
      return "agent_fallback";
    },
    agentsSince: (_key, since) => agents.filter((a) => a.at >= since).map((a) => a.id),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      polls += 1;
      if (opts.letsGoAfterPolls !== undefined && polls >= opts.letsGoAfterPolls) {
        if (opts.modelHandsOff) agents.push({ id: "agent_model", at: clock });
        busy = false;
      }
    },
  };
  return { deps, injected, interrupted, spawned };
}

describe("clearForCall", () => {
  test("an idle conversation needs nothing", async () => {
    const { deps, injected } = fakeDeps({ busy: false });
    expect(await clearForCall(deps, KEY, "Dana", 7_000)).toEqual([]);
    expect(injected).toEqual([]);
  });

  test("a busy turn is asked to hand off, and the agent it starts is reported", async () => {
    const { deps, injected, interrupted, spawned } = fakeDeps({
      busy: true,
      letsGoAfterPolls: 3,
      modelHandsOff: true,
    });
    expect(await clearForCall(deps, KEY, "Dana", 7_000)).toEqual(["agent_model"]);
    expect(injected).toEqual([handoffNotice("Dana")]);
    expect(interrupted).toEqual([]);
    expect(spawned).toEqual([]);
  });

  test("a turn that cannot let go in time is stopped and its request given to an agent", async () => {
    const { deps, interrupted, spawned } = fakeDeps({ busy: true });
    expect(await clearForCall(deps, KEY, "Dana", 2_000)).toEqual(["agent_fallback"]);
    expect(interrupted).toHaveLength(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("find me flights to Denver");
  });

  test("a turn with nothing recorded to hand on is stopped without inventing a task", async () => {
    const { deps, spawned } = fakeDeps({ busy: true, request: null });
    expect(await clearForCall(deps, KEY, "Dana", 2_000)).toEqual([]);
    expect(spawned).toEqual([]);
  });
});
