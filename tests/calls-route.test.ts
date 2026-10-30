/**
 * The call-audio route rule: Edmund speaks only when FaceTime is listening on
 * his microphone and nothing else, and playing the call to a real speaker.
 */
import { describe, expect, test } from "bun:test";
import { type RouteReport, judgeRoute, parseRoute } from "../src/calls/providers/facetime/route.ts";

const MIC = "Edmund Mic";
const speakers = { name: "Mac mini Speakers", physical: true };

function report(
  inputs: string[],
  outputs = [speakers],
  defaultInput: string | null = MIC,
): RouteReport {
  return {
    defaultInput,
    processes: [{ pid: 818, bundleID: "com.apple.avconferenced", inputs, outputs }],
  };
}

describe("judgeRoute", () => {
  test("ready: listening on Edmund's microphone only, playing to a real speaker", () => {
    expect(judgeRoute(report([MIC]), MIC)).toEqual({ ok: true });
  });

  test("not yet: the microphone has not opened (a call reports active ~2.4 s early)", () => {
    const verdict = judgeRoute(report([]), MIC);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.detail).toContain("has not opened a microphone");
  });

  test("refused: listening on another device, and the default input is named", () => {
    const verdict = judgeRoute(report(["BlackHole 2ch"], [speakers], "BlackHole 2ch"), MIC);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.detail).toContain("listening on BlackHole 2ch, not Edmund Mic");
    expect(!verdict.ok && verdict.detail).toContain("default input is BlackHole 2ch");
  });

  test("refused: Edmund's microphone plus another one", () => {
    expect(judgeRoute(report([MIC, "USB Mic"]), MIC).ok).toBe(false);
  });

  test("refused: the call plays into a virtual device, where it would loop back", () => {
    const verdict = judgeRoute(report([MIC], [{ name: "Edmund Feed", physical: false }]), MIC);
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.detail).toContain("Edmund Feed");
  });

  test("not yet: no speaker open", () => {
    expect(judgeRoute(report([MIC], []), MIC).ok).toBe(false);
  });

  test("across processes: every input counts", () => {
    const verdict = judgeRoute(
      {
        defaultInput: MIC,
        processes: [
          { pid: 818, bundleID: "com.apple.avconferenced", inputs: [MIC], outputs: [speakers] },
          { pid: 900, bundleID: "com.apple.FaceTime", inputs: ["BlackHole 2ch"], outputs: [] },
        ],
      },
      MIC,
    );
    expect(verdict.ok).toBe(false);
  });
});

describe("parseRoute", () => {
  test("reads EdmundMouth's report, and a missing physical flag is not physical", () => {
    const parsed = parseRoute({
      defaultInput: MIC,
      processes: [
        {
          pid: 818,
          bundleID: "com.apple.avconferenced",
          inputs: [MIC],
          outputs: [{ name: "Mac mini Speakers", physical: true }, { name: "Odd" }],
        },
      ],
    });
    expect(parsed.processes[0]!.outputs).toEqual([speakers, { name: "Odd", physical: false }]);
  });

  test("garbage is an empty report, which is never ready", () => {
    expect(judgeRoute(parseRoute(null), MIC).ok).toBe(false);
  });
});
