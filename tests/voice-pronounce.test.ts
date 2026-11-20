/**
 * src/voice/pronounce.py: which text misaki is handed, and that Kokoro's
 * voice does not depend on misaki being installed.
 *
 * The module is run under the machine's python3 against a stand-in `misaki`
 * that echoes what it was given, so the test needs neither the model nor the
 * real package. No python3: skipped.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const python = Bun.which("python3");
const voiceDir = resolve(import.meta.dir, "..", "src", "voice");

let dir: string;
let stubs: string;

/** Runs `steps` in one python process: each writes the overrides file (or not) and phonemizes. */
function run(
  steps: { file?: string | null; text: string }[],
  withMisaki = true,
): { loaded: boolean; out: (string | null)[]; log: string[] } {
  const driver = join(dir, "driver.py");
  writeFileSync(
    driver,
    `
import json, os, sys, time
sys.path.insert(0, ${JSON.stringify(voiceDir)})
import pronounce
steps = json.loads(sys.argv[1]); path = sys.argv[2]; log = []
g2p = pronounce.load(path, log.append)
out = []
for i, step in enumerate(steps):
    if "file" in step:
        if step["file"] is None:
            if os.path.exists(path): os.remove(path)
        else:
            with open(path, "w", encoding="utf-8") as f: f.write(step["file"])
            os.utime(path, (1_700_000_000 + i, 1_700_000_000 + i))
    out.append(g2p(step["text"]) if g2p else None)
print(json.dumps({"loaded": g2p is not None, "out": out, "log": log}))
`,
  );
  const proc = Bun.spawnSync(
    [python!, driver, JSON.stringify(steps), join(dir, "pronounce.json")],
    {
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONPATH: withMisaki ? stubs : "",
        PYTHONNOUSERSITE: "1",
      },
    },
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pronounce-"));
  stubs = join(dir, "stubs");
  mkdirSync(join(stubs, "misaki"), { recursive: true });
  writeFileSync(join(stubs, "misaki", "__init__.py"), "");
  // Echoes its input, so a test reads exactly what misaki was handed.
  writeFileSync(
    join(stubs, "misaki", "en.py"),
    "class G2P:\n    def __init__(self, trf=False, british=False, fallback=None):\n        pass\n    def __call__(self, text):\n        return text, []\n",
  );
  writeFileSync(
    join(stubs, "misaki", "espeak.py"),
    "class EspeakFallback:\n    def __init__(self, british=False):\n        pass\n",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!python)("pronounce.py", () => {
  test("a word misaki cannot say is handed over with its phonemes", () => {
    const { out } = run([
      { file: null, text: "Hmm. Let me think." },
      { text: "hmm, HM, and hmmm" },
    ]);
    // "Hmm" is misaki's "hmm", no vowel: Kokoro made noise of it (heard as
    // "And Millie."). The capital is kept, the phonemes are ours.
    expect(out[0]).toBe("[Hmm](/həm/). Let me think.");
    // Whole words only: "hmmm" is a different word.
    expect(out[1]).toBe("[hmm](/həm/), [HM](/həm/), and hmmm");
  });

  test("the operator's file adds words, and a possessive is left to the lexicon", () => {
    const { out } = run([
      {
        file: JSON.stringify({ Edmund: "ˈɛdmən" }),
        text: "It's Edmund. Edmund's voice, Edmundson, and edmund again.",
      },
    ]);
    expect(out[0]).toBe(
      "It's [Edmund](/ˈɛdmən/). Edmund's voice, Edmundson, and [edmund](/ˈɛdmən/) again.",
    );
  });

  test("text already marked up is not marked again", () => {
    const { out } = run([
      { file: JSON.stringify({ Edmund: "ˈɛdmən" }), text: "It's [Edmund](/ˈɛdmənd/)." },
    ]);
    expect(out[0]).toBe("It's [Edmund](/ˈɛdmənd/).");
  });

  test("a change to the file is heard on the next sentence, and so is its removal", () => {
    const { out } = run([
      { file: JSON.stringify({ Edmund: "ˈɛdmən" }), text: "Edmund." },
      { file: JSON.stringify({ Edmund: "ˈɛdmənd" }), text: "Edmund." },
      { file: null, text: "Edmund. Hmm." },
    ]);
    expect(out).toEqual([
      "[Edmund](/ˈɛdmən/).",
      "[Edmund](/ˈɛdmənd/).",
      // The built-in words do not live in the file.
      "Edmund. [Hmm](/həm/).",
    ]);
  });

  test("an entry that would break the markup is dropped, the rest kept", () => {
    const { out, log } = run([
      {
        file: JSON.stringify({ Edmund: "ˈɛdmən", Okay: "o/k", "two words": "x", Sure: 5 }),
        text: "Okay, sure, Edmund.",
      },
    ]);
    expect(out[0]).toBe("Okay, sure, [Edmund](/ˈɛdmən/).");
    expect(log.filter((line) => line.includes("ignored")).length).toBe(3);
  });

  test("a file that is not JSON leaves the built-in words working", () => {
    const { out, log } = run([{ file: "{not json", text: "Hmm. Edmund." }]);
    expect(out[0]).toBe("[Hmm](/həm/). Edmund.");
    expect(log.some((line) => line.includes("unreadable"))).toBe(true);
  });

  test("without misaki there is no phonemizer, and the log says where phonemes come from", () => {
    const { loaded, out, log } = run([{ text: "Hmm." }], false);
    expect(loaded).toBe(false);
    expect(out).toEqual([null]);
    expect(log.join("\n")).toContain("espeak");
  });
});
