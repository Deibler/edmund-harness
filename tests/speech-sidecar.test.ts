import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SpeechSidecar } from "../integrations/mirror/src/speech.ts";
import type { Config } from "../src/config/config.ts";

/**
 * The sidecar's contract is "produce 24 kHz PCM16, or return null so the
 * caller falls back". These tests pin both halves: the real subprocess when
 * Kokoro is provisioned on this machine, and the null path when it is not.
 */

function makeConfig(overrides: Partial<Config["mirror"]> = {}): Config {
  return {
    mirror: {
      enabled: true,
      kokoro_enabled: true,
      kokoro_voice: "af_heart",
      kokoro_python: "",
      kokoro_model: "",
      kokoro_voices: "",
      ...overrides,
    },
  } as unknown as Config;
}

const provisioned = new SpeechSidecar(makeConfig()).installed();
const runLiveSynthesis = provisioned && process.env.RUN_KOKORO_SMOKE === "1";

describe("SpeechSidecar provisioning", () => {
  test("reports every missing dependency by name", () => {
    const sidecar = new SpeechSidecar(
      makeConfig({
        kokoro_python: "/nonexistent/python3",
        kokoro_model: "/nonexistent/model.onnx",
        kokoro_voices: "/nonexistent/voices.bin",
      }),
    );

    expect(sidecar.installed()).toBe(false);
    const missing = sidecar.missingPaths();
    expect(missing).toContain("python=/nonexistent/python3");
    expect(missing).toContain("model=/nonexistent/model.onnx");
    expect(missing).toContain("voices=/nonexistent/voices.bin");
  });

  test("returns null instead of throwing when nothing is installed", async () => {
    const sidecar = new SpeechSidecar(
      makeConfig({
        kokoro_python: "/nonexistent/python3",
        kokoro_model: "/nonexistent/model.onnx",
        kokoro_voices: "/nonexistent/voices.bin",
      }),
    );

    expect(await sidecar.synthesize("this must not throw")).toBeNull();
    sidecar.stop();
  });

  test("expands ~ in configured paths", () => {
    const sidecar = new SpeechSidecar(makeConfig({ kokoro_model: "~/definitely-not-here.onnx" }));
    // A literal "~" would never exist; expansion is what makes the check meaningful.
    expect(sidecar.missingPaths().some((entry) => entry.startsWith("model=/"))).toBe(true);
  });

  test("a stopped sidecar refuses further work", async () => {
    const sidecar = new SpeechSidecar(makeConfig());
    sidecar.stop();
    expect(await sidecar.synthesize("after stop")).toBeNull();
  });

  test("rejects empty text without spawning anything", async () => {
    const sidecar = new SpeechSidecar(makeConfig());
    expect(await sidecar.synthesize("   ")).toBeNull();
    sidecar.stop();
  });
});

// The real subprocess is an opt-in smoke test: loading Kokoro + Whisper is
// machine-specific and resource-heavy, so the deterministic default suite
// exercises the failure contract while RUN_KOKORO_SMOKE=1 exercises the local
// model installation explicitly.
describe.if(runLiveSynthesis)("SpeechSidecar synthesis", () => {
  test(
    "produces 24 kHz PCM16 and reuses one warm process across requests",
    async () => {
      const sidecar = new SpeechSidecar(makeConfig());
      try {
        const first = await sidecar.synthesize("Good morning.");
        expect(first).not.toBeNull();
        expect(first!.sampleRate).toBe(24_000);
        // PCM16 is 2 bytes per frame; anything odd means a framing bug.
        expect(first!.pcm.length % 2).toBe(0);
        // A real utterance is at least ~0.2s of audio.
        expect(first!.pcm.length).toBeGreaterThan(0.2 * 24_000 * 2);

        // Non-silent: an all-zero buffer would still satisfy the size checks.
        const peak = Math.max(...new Int16Array(first!.pcm.buffer.slice(0)).map(Math.abs));
        expect(peak).toBeGreaterThan(1_000);

        // The second request must not pay model-load cost again.
        const started = performance.now();
        const second = await sidecar.synthesize("It is seventy two degrees.");
        const elapsedMs = performance.now() - started;
        expect(second).not.toBeNull();
        expect(elapsedMs).toBeLessThan(5_000);

        // Longer text yields more audio — proof the text actually drove synthesis.
        expect(second!.pcm.length).toBeGreaterThan(first!.pcm.length);
      } finally {
        sidecar.stop();
      }
    },
    { timeout: 120_000 },
  );

  test(
    "survives an unknown voice and keeps serving",
    async () => {
      const sidecar = new SpeechSidecar(makeConfig());
      try {
        expect(await sidecar.synthesize("bad voice", "not_a_real_voice")).toBeNull();
        // The failure must be contained to that request, not the process.
        expect(await sidecar.synthesize("still working", "af_heart")).not.toBeNull();
      } finally {
        sidecar.stop();
      }
    },
    { timeout: 120_000 },
  );

  test(
    "matches concurrent responses to their own requests",
    async () => {
      const sidecar = new SpeechSidecar(makeConfig());
      try {
        // Distinct lengths make a swapped correlation id detectable.
        const [short, long] = await Promise.all([
          sidecar.synthesize("Yes."),
          sidecar.synthesize(
            "The forecast calls for clear skies through Sunday with highs near eighty.",
          ),
        ]);
        expect(short).not.toBeNull();
        expect(long).not.toBeNull();
        expect(long!.pcm.length).toBeGreaterThan(short!.pcm.length * 2);
      } finally {
        sidecar.stop();
      }
    },
    { timeout: 120_000 },
  );
});

describe.if(!runLiveSynthesis)("SpeechSidecar synthesis", () => {
  test("skipped — set RUN_KOKORO_SMOKE=1 after installing Kokoro to run the live sidecar", () => {
    expect(existsSync("/")).toBe(true);
  });
});
