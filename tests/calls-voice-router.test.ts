/** src/calls/voice-router.ts: which engine says a line, and who says it when that engine cannot. */

import { describe, expect, test } from "bun:test";
import { type Audio, routeVoice } from "../src/calls/voice-router.ts";

const audio = (n: number): Audio => ({ pcm: new Uint8Array(n), sampleRate: 24_000 });

function setUp(phononAnswers: (Audio | null)[] = []) {
  const said: string[] = [];
  const warned: Record<string, unknown>[] = [];
  const say = routeVoice({
    phonon: async (text, voice, speed) => {
      said.push(`phonon ${voice} ${speed} ${text}`);
      return phononAnswers.length > 0 ? phononAnswers.shift()! : audio(1);
    },
    kokoro: async (text, voice, speed) => {
      said.push(`kokoro ${voice} ${speed} ${text}`);
      return audio(2);
    },
    fallbackVoice: "am_fenrir",
    warn: (_message, fields) => warned.push(fields),
  });
  return { say, said, warned };
}

describe("routeVoice", () => {
  test("a Phonon voice is spoken by Phonon, by its catalog name", async () => {
    const { say, said, warned } = setUp();
    expect((await say("Hello.", "phonon:Old Mortlake", 1.1))?.pcm.length).toBe(1);
    expect(said).toEqual(["phonon Old Mortlake 1.1 Hello."]);
    expect(warned).toEqual([]);
  });

  test("a Kokoro voice or blend goes to Kokoro as written", async () => {
    const { say, said } = setUp();
    await say("Hello.", "bm_george:0.5,am_santa:0.5", 1);
    expect(said).toEqual(["kokoro bm_george:0.5,am_santa:0.5 1 Hello."]);
  });

  test("a line Phonon cannot say is said by Kokoro, at the same speed, and that is logged", async () => {
    const { say, said, warned } = setUp([null, audio(1)]);
    expect((await say("First.", "phonon:Micah", 1.2))?.pcm.length).toBe(2);
    // The next line is Phonon's again: one failure does not write it off.
    expect((await say("Second.", "phonon:Micah", 1.2))?.pcm.length).toBe(1);
    expect(said).toEqual([
      "phonon Micah 1.2 First.",
      "kokoro am_fenrir 1.2 First.",
      "phonon Micah 1.2 Second.",
    ]);
    expect(warned).toEqual([{ voice: "phonon:Micah", fallback: "am_fenrir", chars: 6 }]);
  });
});
