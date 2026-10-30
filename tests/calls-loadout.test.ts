/**
 * How a conversation's worker runs while it is on a call: less thinking per
 * reply, and none of the tools that left a caller in silence for 40 s on the
 * first live call. Off the call, nothing changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type VoiceBinding, bindVoice, clearVoiceBindings } from "../src/calls/binding.ts";
import { withCallBlocks } from "../src/calls/loadout.ts";
import { wantsAutoRecall } from "../src/channels/turn.ts";
import type { Config } from "../src/config/config.ts";
import { modelProfileForSession } from "../src/model/profile.ts";

const DM = "imessage:dm:+15550100001";
const OTHER = "imessage:dm:+15550100002";

const config = {
  claude: { model: "claude-opus-5-5", effort: "xhigh" },
  mirror: { session_key: "mirror:pi-4", model: "claude-haiku-5-5", effort: "medium" },
  trading: { model: "", effort: "" },
  facetime: { effort: "low", model: "claude-sonnet-5-5" },
} as Config;

const binding: VoiceBinding = {
  callId: "call_1",
  deliver: async () => "spoken",
  onTurnStarted: () => {},
  onTextDelta: () => {},
  onTurnSettled: () => {},
  envelopeBlock: () => "",
};

afterEach(() => clearVoiceBindings());

describe("the call loadout", () => {
  test("off a call, the conversation runs as configured", () => {
    expect(modelProfileForSession(DM, config)).toEqual({
      model: "claude-opus-5-5",
      effort: "xhigh",
    });
    expect(withCallBlocks("Task", DM, config)).toBe("Task");
  });

  test("on a call: the call's model and effort, and the blocking tools off", () => {
    bindVoice(DM, binding);
    expect(modelProfileForSession(DM, config)).toEqual({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
    expect(withCallBlocks("Task", DM, config).split(" ")).toEqual([
      "Task",
      "Bash",
      "WebFetch",
      "WebSearch",
    ]);
  });

  test("only the conversation on the call changes", () => {
    bindVoice(DM, binding);
    expect(modelProfileForSession(OTHER, config).effort).toBe("xhigh");
    expect(withCallBlocks("Task", OTHER, config)).toBe("Task");
  });

  test("a tool already off is not listed twice (sandboxed workers already lose Bash)", () => {
    bindVoice(DM, binding);
    const list = withCallBlocks("Task Bash Read", DM, config).split(" ");
    expect(list.filter((t) => t === "Bash")).toEqual(["Bash"]);
  });
});

describe("the call model setting", () => {
  test("empty keeps the conversation's own model", () => {
    bindVoice(DM, binding);
    const keep = { ...config, facetime: { effort: "low", model: "" } } as Config;
    expect(modelProfileForSession(DM, keep)).toEqual({ model: "claude-opus-5-5", effort: "low" });
  });
});

describe("automatic recall", () => {
  test("a spoken turn on a call does not wait on it", () => {
    expect(wantsAutoRecall({ iter: 0, guest: false, onCall: true })).toBe(false);
  });

  test("an ordinary first turn still recalls; guests and later iterations never do", () => {
    expect(wantsAutoRecall({ iter: 0, guest: false, onCall: false })).toBe(true);
    expect(wantsAutoRecall({ iter: 0, guest: true, onCall: false })).toBe(false);
    expect(wantsAutoRecall({ iter: 1, guest: false, onCall: false })).toBe(false);
  });
});
