/**
 * src/voice/phonon-sidecar.py, run for real under the machine's python3
 * against a stand-in `ptts` that returns a tone between Phonon-sized pads and
 * records what it was asked. Needs python3 with numpy; skipped without.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const python = Bun.which("python3");
const hasNumpy = python !== null && Bun.spawnSync([python, "-c", "import numpy"]).exitCode === 0;
const script = resolve(import.meta.dir, "..", "src", "voice", "phonon-sidecar.py");
const RATE = 24_000;

let dir: string;
let stubs: string;

type Reply = {
  id: string;
  ok: boolean;
  error?: string;
  pcm16?: string;
  rate?: number;
  voices?: string[];
  detail?: string;
};

/** One sidecar process: its replies by id, and what the stand-in ptts was asked, in order. */
function run(requests: Record<string, unknown>[], env: Record<string, string> = {}) {
  const asked = join(dir, `asked-${Math.random().toString(36).slice(2)}.jsonl`);
  const proc = Bun.spawnSync([python!, script], {
    stdin: Buffer.from(`${requests.map((r) => JSON.stringify(r)).join("\n")}\n`),
    env: {
      PATH: process.env.PATH ?? "",
      PYTHONPATH: stubs,
      PTTS_STUB_LOG: asked,
      PHONON_VOICE: "Micah",
      ...env,
    },
  });
  const replies = new Map<string, Reply>();
  for (const line of proc.stdout.toString().split("\n").filter(Boolean)) {
    const reply = JSON.parse(line) as Reply;
    replies.set(reply.id, reply);
  }
  const events = existsSync(asked)
    ? readFileSync(asked, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  return { replies, events, stderr: proc.stderr.toString() };
}

const seconds = (reply: Reply | undefined) =>
  Buffer.from(reply?.pcm16 ?? "", "base64").length / 2 / RATE;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "phonon-"));
  stubs = join(dir, "stubs");
  mkdirSync(join(stubs, "ptts"), { recursive: true });
  // One second of tone (60 s when asked to run on) between the pads Phonon
  // leaves: 0.14 s of near-silence before and 0.63 s of silence after.
  writeFileSync(
    join(stubs, "ptts", "__init__.py"),
    `
import json, os
import numpy as np

DEFAULT_MODEL = "stub-model"
RATE = 24000

def _note(event):
    with open(os.environ["PTTS_STUB_LOG"], "a") as f:
        f.write(json.dumps(event) + "\\n")

def catalog_voices():
    return [{"name": "Micah", "language": "en"}, {"name": "Noa", "language": "es"}, {"name": "Easton", "language": "en"}]

class TTS:
    sample_rate = RATE
    device = "cpu"
    voices = ["default"]

    def __init__(self, model, lang=None, device=None):
        _note({"init": model, "lang": lang, "device": device})

    def set_conditions(self, conditions):
        _note({"conditions": conditions})

    def synth(self, text, voice=None, seed=None):
        _note({"synth": text, "voice": voice, "seed": seed})
        if voice not in ("Micah", "Easton"):
            raise LookupError(f"no voice {voice!r} is registered")
        # Like Phonon, the same reading every time unless the seed changes.
        long = text == "RUN ON" or (text == "RUN ON ONCE" and seed is None)
        n = int((60.0 if long else 1.0) * RATE)
        tone = (0.5 * np.sin(2 * np.pi * 220 * np.arange(n) / RATE)).astype(np.float32)
        if text == "SILENT":
            tone *= 0
        before = np.full(int(0.14 * RATE), 0.0023, dtype=np.float32)
        after = np.zeros(int(0.63 * RATE), dtype=np.float32)
        return np.concatenate([before, tone, after])
`,
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasNumpy)("phonon-sidecar.py", () => {
  test("it boots on the CPU, warms the voice it was given, and lists the English voices", () => {
    const { replies, events } = run([{ id: "v", voices: true }]);
    expect(replies.get("boot")).toMatchObject({
      ok: true,
      ready: true,
      detail: "device=cpu voices=2",
    });
    expect(events[0]).toEqual({ init: "stub-model", lang: "en", device: "cpu" });
    expect(events).toContainEqual({ synth: "Ready.", voice: "Micah", seed: null });
    expect(replies.get("v")?.voices).toEqual(["Micah", "Easton"]);
  });

  test("a sentence comes back without Phonon's pads", () => {
    const { replies } = run([{ id: "1", text: "Good morning.", voice: "Easton", speed: 1 }]);
    const reply = replies.get("1");
    expect(reply).toMatchObject({ ok: true, rate: RATE });
    // 1.77 s as synthesised: 0.14 s + 1 s of speech + 0.63 s. Kept: the speech,
    // 50 ms before it and 120 ms after.
    expect(seconds(reply)).toBeGreaterThan(1.15);
    expect(seconds(reply)).toBeLessThan(1.19);
  });

  test("speed becomes Phonon's pace, within the range that was tried, and 1 is its own pace", () => {
    const { events } = run([
      { id: "1", text: "One.", voice: "Micah", speed: 1 },
      { id: "2", text: "Two.", voice: "Micah", speed: 1.25 },
      { id: "3", text: "Three.", voice: "Micah", speed: 1.25 },
      { id: "4", text: "Four.", voice: "Micah", speed: 2 },
      { id: "5", text: "Five.", voice: "Micah", speed: 0.5 },
      { id: "6", text: "Six.", voice: "Micah", speed: 1 },
    ]);
    const paces = events.filter((e) => "conditions" in e).map((e) => e.conditions);
    expect(paces).toHaveLength(4);
    // Faster is a negative delta: -ln(1.25). Set once for two sentences alike.
    expect((paces[0] as { duration_delta: number }).duration_delta).toBeCloseTo(-0.2231, 3);
    expect(paces[1]).toEqual({ duration_delta: -0.5 });
    expect(paces[2]).toEqual({ duration_delta: 0.5 });
    // Back to 1: the condition is taken off, not set to zero.
    expect(paces[3]).toEqual({});
  });

  test("speech far too long for its text is tried again, and refused the second time", () => {
    const { replies, events, stderr } = run([
      { id: "once", text: "RUN ON ONCE", voice: "Micah" },
      { id: "twice", text: "RUN ON", voice: "Micah" },
      { id: "after", text: "Still here.", voice: "Micah" },
    ]);
    expect(replies.get("once")?.ok).toBe(true);
    expect(seconds(replies.get("once"))).toBeLessThan(1.2);
    // Asked the same way twice it would run on twice: the second try is seeded.
    expect(events.filter((e) => e.synth === "RUN ON ONCE").map((e) => e.seed)).toEqual([null, 2]);
    expect(replies.get("twice")).toMatchObject({ ok: false });
    expect(events.filter((e) => e.synth === "RUN ON")).toHaveLength(2);
    expect(stderr).toContain("[phonon] attempt 2: 60.");
    // A refusal is one line lost, not the sidecar.
    expect(replies.get("after")?.ok).toBe(true);
  });

  test("silence is not speech", () => {
    const { replies } = run([{ id: "1", text: "SILENT", voice: "Micah" }]);
    expect(replies.get("1")).toMatchObject({ ok: false });
  });

  test("a voice the catalog does not have fails that line and no other", () => {
    const { replies } = run([
      { id: "1", text: "Hello.", voice: "Nobody" },
      { id: "2", text: "Hello.", voice: "Micah" },
    ]);
    expect(replies.get("1")?.ok).toBe(false);
    expect(replies.get("1")?.error).toContain("Nobody");
    expect(replies.get("2")?.ok).toBe(true);
  });

  test("a voice that cannot be warmed does not stop the sidecar from booting", () => {
    const { replies } = run([{ id: "1", text: "Hello.", voice: "Micah" }], {
      PHONON_VOICE: "Nobody",
    });
    expect(replies.get("boot")).toMatchObject({ ok: true, ready: true });
    expect(replies.get("1")?.ok).toBe(true);
  });
});
