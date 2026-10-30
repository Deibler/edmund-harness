/**
 * The turn detector end to end: the real sidecar and Smart Turn model, over
 * its JSON protocol, on speech rendered by macOS `say` (to a file; nothing
 * plays). Skipped where the Kokoro venv or the model is absent (CI).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPython } from "../src/voice/speech-sidecar.ts";
import { TurnDetector } from "../src/voice/turn-detector.ts";

const model = resolve(import.meta.dir, "../native/facetime/build/smart-turn-v3.2-cpu.onnx");
const installed = existsSync(defaultPython()) && existsSync(model) && process.platform === "darwin";
const dir = mkdtempSync(join(tmpdir(), "edmund-turn-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 16 kHz mono 16-bit PCM of `text`, as base64. */
function speech(text: string): string {
  const path = join(dir, `${text.length}.wav`);
  spawnSync("say", ["-o", path, "--file-format=WAVE", "--data-format=LEI16@16000", text]);
  const wav = readFileSync(path);
  const data = wav.indexOf("data");
  const length = wav.readUInt32LE(data + 4);
  return wav.subarray(data + 8, data + 8 + length).toString("base64");
}

describe.skipIf(!installed)("TurnDetector", () => {
  test("a finished sentence scores as a turn end; one that trails off does not", async () => {
    const detector = new TurnDetector({ python: defaultPython(), model, timeoutMs: 5_000 });
    detector.start();
    const finished = speech("Okay, I'll meet you at the coffee shop at five.");
    const trailing = speech("So I was thinking that maybe we could, um, and then");
    let done = null;
    for (let i = 0; i < 50 && !done; i++) {
      done = await detector.verdict(finished);
      if (!done) await new Promise((r) => setTimeout(r, 200));
    }
    const open = await detector.verdict(trailing);
    detector.stop();
    expect(done?.probability).toBeGreaterThan(0.5);
    expect(open?.probability).toBeLessThan(0.5);
    expect(done!.ms).toBeLessThan(200);
  }, 30_000);

  test("unusable input is no verdict, never a throw", async () => {
    const detector = new TurnDetector({ python: defaultPython(), model, timeoutMs: 5_000 });
    expect(await detector.verdict("")).toBeNull();
    detector.stop();
  });
});
