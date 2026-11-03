/**
 * The daemon-side ear, against a scripted transcriber and turn detector: what
 * it emits, in what order, and what a failure turns into. The audio is
 * synthetic: noise at speech level is "talking", digital zero is quiet.
 */
import { describe, expect, test } from "bun:test";
import { Ear, INAUDIBLE, VoiceActivity } from "../src/calls/ear.ts";
import type { ProviderEvent } from "../src/calls/types.ts";

const RATE = 16_000;

/** `ms` of noise at about -20 dBFS: loud enough to be voiced. */
function talk(ms: number): Int16Array {
  const out = new Int16Array((ms * RATE) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round((Math.random() * 2 - 1) * 5_000);
  return out;
}
const quiet = (ms: number) => new Int16Array((ms * RATE) / 1000);

/** Feed in 20 ms frames, as a provider would. */
function feed(ear: Ear, samples: Int16Array): void {
  for (let i = 0; i < samples.length; i += 320) ear.feed(samples.subarray(i, i + 320));
}

type Gate = { resolve: (value: { text: string } | null) => void };

/** A transcriber whose answers the test hands out, one request at a time. */
function scripted() {
  const requests: { samples: number; gate: Gate }[] = [];
  return {
    requests,
    transcribe: (pcm: Uint8Array) =>
      new Promise<{ text: string } | null>((resolve) => {
        requests.push({ samples: pcm.byteLength / 2, gate: { resolve } });
      }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

function ear(transcribe: (pcm: Uint8Array) => Promise<{ text: string } | null>, verdict = 0.9) {
  const events: ProviderEvent[] = [];
  const e = new Ear({
    transcribe,
    turnVerdict: async () => verdict,
    emit: (event) => events.push(event),
    now: () => 1_000_000,
  });
  e.begin();
  return { ear: e, events };
}

const kinds = (events: ProviderEvent[]) =>
  events.map((e) =>
    e.type === "heard" ? `heard:${e.final ? "final" : "partial"}:${e.text}` : e.type,
  );

describe("VoiceActivity", () => {
  test("speech starts where the voice did and pauses where it stopped", () => {
    const vad = new VoiceActivity();
    const audio = [quiet(500), talk(1000), quiet(500)];
    const events: Array<["start" | "pause", number]> = [];
    let at = 0;
    for (const chunk of audio) {
      events.push(...vad.feed(chunk, at));
      at += chunk.length;
    }
    expect(events.map(([k]) => k)).toEqual(["start", "pause"]);
    expect(events[0]![1]).toBe(500 * 16);
    expect(events[1]![1]).toBe(1500 * 16);
  });
});

describe("Ear", () => {
  test("a stretch of speech becomes speech, then its pause and words together", async () => {
    const t = scripted();
    const { ear: e, events } = ear(t.transcribe);
    feed(e, quiet(300));
    feed(e, talk(500));
    feed(e, quiet(400));
    await settle();
    expect(kinds(events)).toEqual(["speech"]);
    // The whole stretch went in one request, preroll and tail included.
    const final = t.requests.at(-1)!;
    expect(final.samples).toBeGreaterThanOrEqual((500 + 200) * 16);
    final.gate.resolve({ text: "hello there" });
    await settle();
    expect(kinds(events)).toEqual(["speech", "pause", "heard:final:hello there"]);
    const pause = events[1] as Extract<ProviderEvent, { type: "pause" }>;
    expect(pause.probability).toBe(0.9);
  });

  test("a transcriber that cannot say is INAUDIBLE, never silence", async () => {
    const t = scripted();
    const { ear: e, events } = ear(t.transcribe);
    feed(e, talk(500));
    feed(e, quiet(400));
    t.requests.at(-1)!.gate.resolve(null);
    await settle();
    expect(kinds(events)).toEqual(["speech", "pause", `heard:final:${INAUDIBLE}`]);
  });

  test("a stretch with no words (a cough) still reports its pause, and nothing heard", async () => {
    const t = scripted();
    const { ear: e, events } = ear(t.transcribe);
    feed(e, talk(300));
    feed(e, quiet(400));
    t.requests.at(-1)!.gate.resolve({ text: "  " });
    await settle();
    expect(kinds(events)).toEqual(["speech", "pause"]);
  });

  test("the next stretch's start waits for the previous stretch's words", async () => {
    const t = scripted();
    const { ear: e, events } = ear(t.transcribe);
    feed(e, talk(400));
    feed(e, quiet(300));
    const first = t.requests.at(-1)!;
    feed(e, talk(400));
    await settle();
    // Talking again, but the first stretch's words are still out.
    expect(kinds(events)).toEqual(["speech"]);
    first.gate.resolve({ text: "one" });
    await settle();
    expect(kinds(events)).toEqual(["speech", "pause", "heard:final:one", "speech"]);
  });

  test("words in progress are read while talking, and not after the pause", async () => {
    const t = scripted();
    const { ear: e, events } = ear(t.transcribe);
    feed(e, talk(700));
    await settle();
    const partial = t.requests.at(-1)!;
    partial.gate.resolve({ text: "stop for" });
    await settle();
    expect(kinds(events)).toEqual(["speech", "heard:partial:stop for"]);
    // A partial that comes back after its stretch closed says nothing.
    feed(e, talk(700));
    const late = t.requests.at(-1)!;
    feed(e, quiet(400));
    late.gate.resolve({ text: "stale words" });
    t.requests.at(-1)!.gate.resolve({ text: "stop for a second" });
    await settle();
    expect(kinds(events)).toEqual([
      "speech",
      "heard:partial:stop for",
      "pause",
      "heard:final:stop for a second",
    ]);
  });

  test("hanging up drops whatever was still being transcribed", async () => {
    const t = scripted();
    const { ear: e, events } = ear(t.transcribe);
    feed(e, talk(400));
    feed(e, quiet(300));
    await settle();
    e.end();
    for (const r of t.requests) r.gate.resolve({ text: "after the call" });
    await settle();
    expect(kinds(events)).toEqual(["speech"]);
    // And nothing fed after the call is heard.
    const before = t.requests.length;
    feed(e, talk(1_000));
    feed(e, quiet(400));
    expect(t.requests.length).toBe(before);
  });

  test("a monologue with no pause is settled every 30 s, not held forever", async () => {
    const answered: number[] = [];
    const { ear: e, events } = ear(async (pcm) => {
      answered.push(pcm.byteLength / 2);
      return { text: "and so on" };
    });
    feed(e, talk(31_000));
    await settle();
    expect(events.filter((x) => x.type === "heard" && x.final).length).toBe(1);
    expect(Math.max(...answered)).toBeGreaterThanOrEqual(30 * RATE);
  });

  test("when they stopped is read from when the audio arrived, even arriving slow", async () => {
    // Every 20 ms frame takes 25 ms to arrive. Counting from the first
    // sample would put the stop 375 ms before it reached us.
    let clock = 0;
    const events: ProviderEvent[] = [];
    const e = new Ear({
      transcribe: async () => ({ text: "hello" }),
      turnVerdict: async () => 0.9,
      emit: (event) => events.push(event),
      now: () => clock,
    });
    e.begin();
    const audio = [quiet(500), talk(1_000), quiet(500)];
    for (const chunk of audio) {
      for (let i = 0; i < chunk.length; i += 320) {
        clock += 25;
        e.feed(chunk.subarray(i, i + 320));
      }
    }
    await settle();
    const pause = events.find((x) => x.type === "pause");
    // The last talking frame (audio 1,500 ms) arrived at 1,875 ms.
    expect(pause?.type === "pause" && Math.abs(pause.stoppedAtMs - 1_875) < 100).toBe(true);
  });
});
