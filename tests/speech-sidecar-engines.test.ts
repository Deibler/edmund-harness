/**
 * SpeechSidecar with two engines: which script it runs, what it needs to be
 * installed, and which of two sidecars stays loaded.
 *
 * A stand-in interpreter does the boot handshake and records how it was
 * started, so nothing here needs Kokoro, Phonon or python.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechSidecar } from "../src/voice/speech-sidecar.ts";

const dir = mkdtempSync(join(tmpdir(), "sidecar-engines-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const started = join(dir, "started");
const fakePython = join(dir, "python3");
writeFileSync(
  fakePython,
  `#!/bin/sh\nprintf '%s|%s\\n' "$1" "$PHONON_VOICE" >> ${started}\necho '{"id":"boot","ok":true,"ready":true,"detail":"device=cpu voices=2"}'\nwhile read -r line; do :; done\n`,
);
chmodSync(fakePython, 0o755);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SpeechSidecar engines", () => {
  test("Phonon needs python and its script, not Kokoro's model files", () => {
    const phonon = new SpeechSidecar({
      engine: "phonon",
      python: fakePython,
      model: join(dir, "absent.onnx"),
      voices: join(dir, "absent.bin"),
      voice: "Micah",
      sttModel: "",
      tag: "test",
    });
    expect(phonon.missingPaths()).toEqual([]);
    expect(phonon.installed()).toBe(true);
    const kokoro = new SpeechSidecar({
      python: fakePython,
      model: join(dir, "absent.onnx"),
      voices: join(dir, "absent.bin"),
      voice: "am_fenrir",
      sttModel: "",
      tag: "test",
    });
    expect(kokoro.installed()).toBe(false);
    expect(kokoro.missingPaths().map((m) => m.split("=")[0])).toEqual(["model", "voices"]);
  });

  test("Phonon runs its own script and is told which voice to warm", async () => {
    const phonon = new SpeechSidecar({
      engine: "phonon",
      python: fakePython,
      voice: "Micah",
      sttModel: "",
      tag: "test",
    });
    try {
      await phonon.warmup();
      expect(phonon.resident()).toBe(true);
      const [script, voice] = readFileSync(started, "utf8").trim().split("\n").at(-1)!.split("|");
      expect(script).toEndWith("/src/voice/phonon-sidecar.py");
      expect(voice).toBe("Micah");
    } finally {
      phonon.stop();
    }
  });

  test("a sidecar stays loaded for as long as it is the resident one, and lets go when it is not", async () => {
    let inUse = true;
    const sidecar = new SpeechSidecar(
      {
        engine: "phonon",
        python: fakePython,
        voice: "Micah",
        sttModel: "",
        tag: "test",
        resident: () => inUse,
      },
      40,
    );
    try {
      await sidecar.warmup();
      await wait(200);
      // Several quiet spells have passed: the voice in use is never unloaded.
      expect(sidecar.resident()).toBe(true);
      // The voice lab switches calls to the other engine.
      inUse = false;
      await wait(200);
      expect(sidecar.resident()).toBe(false);
    } finally {
      sidecar.stop();
    }
  });
});
