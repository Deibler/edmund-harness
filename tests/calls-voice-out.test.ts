/**
 * Edmund's speech on a call: what gets said, in what order, and what happens
 * when the caller talks over him or the call drops.
 */
import { describe, expect, test } from "bun:test";
import { VoiceOut } from "../src/calls/voice-out.ts";

type Said = { text: string; heard: boolean };

function harness(opts: { failSynthesis?: boolean } = {}) {
  const queued: { chunkId: string; text: string }[] = [];
  const said: Said[] = [];
  let flushes = 0;
  const voice = new VoiceOut({
    speaker: {
      synthesize: async (text: string) =>
        opts.failSynthesis ? null : { pcm: new TextEncoder().encode(text), sampleRate: 24_000 },
    },
    provider: {
      say: async (chunkId: string, pcm: Uint8Array) => {
        queued.push({ chunkId, text: new TextDecoder().decode(pcm) });
      },
      flush: async () => {
        flushes += 1;
      },
    },
    onSaid: (text, heard) => said.push({ text, heard }),
  });
  return { voice, queued, said, flushes: () => flushes };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("streaming speech", () => {
  test("a sentence is sent as soon as the next one begins, in order", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "Sure, I can do that. Give me");
    await settle();
    expect(queued.map((q) => q.text)).toEqual(["Sure, I can do that."]);
    voice.delta("t1", " one second while I look.");
    expect(await voice.deliver("Sure, I can do that. Give me one second while I look.", "t1")).toBe(
      "spoken",
    );
    expect(queued.map((q) => q.text)).toEqual([
      "Sure, I can do that.",
      "Give me one second while I look.",
    ]);
  });

  test("an abbreviation or a decimal never ends a sentence", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "Dr. Smith says it is 82.4 degrees. That's warm.");
    await voice.deliver("", "t1");
    expect(queued.map((q) => q.text)).toEqual([
      "Dr. Smith says it is 82.4 degrees.",
      "That's warm.",
    ]);
  });

  test("a control sentinel is never spoken", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "KEEP_QUIET");
    voice.settle("t1", "tool-only");
    await settle();
    expect(queued).toEqual([]);
  });

  test("a reply that did not stream (a cron wake-up) is spoken whole", async () => {
    const { voice, queued } = harness();
    expect(
      await voice.deliver("The agent finished. Your flight is on time and boards at six."),
    ).toBe("spoken");
    expect(queued.map((q) => q.text).join(" ")).toBe(
      "The agent finished. Your flight is on time and boards at six.",
    );
  });

  test("speech it cannot synthesise reports unavailable, so the reply is texted", async () => {
    const { voice } = harness({ failSynthesis: true });
    expect(await voice.deliver("Hello there, this will not synthesise.")).toBe("unavailable");
  });
});

describe("while it rings", () => {
  test("speech is synthesised but held until the call connects", async () => {
    const { voice, queued } = harness();
    voice.hold();
    const delivering = voice.deliver("Hey Dana, what's up?");
    await voice.firstAudioReady();
    await settle();
    expect(queued).toEqual([]);
    voice.release();
    expect(await delivering).toBe("spoken");
    expect(queued.map((q) => q.text)).toEqual(["Hey Dana, what's up?"]);
  });

  test("a greeting for a call that never connected is dropped, not texted", async () => {
    const { voice, queued } = harness();
    voice.hold();
    const delivering = voice.deliver("Hey Dana, what's up?");
    await voice.firstAudioReady();
    voice.close("drop");
    expect(await delivering).toBe("silent");
    expect(queued).toEqual([]);
  });

  test("a reply caught by the end of a connected call is texted instead", async () => {
    const { voice } = harness();
    voice.close("text");
    expect(await voice.deliver("One more thing before you go.")).toBe("unavailable");
  });
});

describe("barge-in", () => {
  test("drops what was not heard, mutes the rest of the turn, and remembers it", async () => {
    const { voice, queued, said, flushes } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "The forecast for tomorrow is sunny. Highs in the seventies. Pack");
    await settle();
    expect(queued).toHaveLength(2);
    voice.onSpoken(queued[0]!.chunkId, true);
    await voice.bargeIn();
    expect(flushes()).toBe(1);
    voice.onSpoken(queued[1]!.chunkId, false);
    voice.delta("t1", "And the weekend looks great too.");
    await settle();
    expect(queued).toHaveLength(2);
    expect(said).toEqual([
      { text: "The forecast for tomorrow is sunny.", heard: true },
      { text: "Highs in the seventies.", heard: false },
    ]);
    expect(voice.takeCutOff()).toEqual({
      kind: "talked-over",
      text: "Highs in the seventies. Pack",
    });
    expect(voice.takeCutOff()).toBeNull();
    expect(await voice.deliver("The forecast…", "t1")).toBe("silent");
  });

  test("the next turn speaks normally", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "Something long. ");
    await voice.bargeIn();
    voice.settle("t1", "interrupted");
    voice.beginTurn("t2");
    voice.delta("t2", "Oh, sorry, go ahead.");
    expect(await voice.deliver("Oh, sorry, go ahead.", "t2")).toBe("spoken");
    expect(queued.map((q) => q.text)).toContain("Oh, sorry, go ahead.");
  });
});

describe("after the call ends", () => {
  test("a reply still streaming is not spoken, and goes out as a text", async () => {
    // The first live call played 36 s of a reply into a line nobody was on.
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.close("text");
    voice.delta("t1", "Okay, I hung up. Here's what I found. It was the cable.");
    await settle();
    expect(queued).toEqual([]);
    expect(await voice.deliver("Okay, I hung up. Here's what I found.", "t1")).toBe("unavailable");
  });
});

describe("drained", () => {
  test("waits for the last sentence, even one still being written, to finish playing", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "Okay, talk soon. Bye Dana");
    let done = false;
    const drained = voice.drained(2_000).then(() => {
      done = true;
    });
    await settle();
    expect(queued.map((q) => q.text)).toEqual(["Okay, talk soon.", "Bye Dana"]);
    expect(done).toBe(false);
    voice.onSpoken(queued[0]!.chunkId, true);
    await settle();
    expect(done).toBe(false); // one still playing
    voice.onSpoken(queued[1]!.chunkId, true);
    await drained;
    expect(done).toBe(true);
  });

  test("gives up after its timeout", async () => {
    const { voice } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "This one never reports back.");
    const started = Date.now();
    await voice.drained(100);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("they kept talking", () => {
  test("a reply not yet begun goes unsaid, and the next turn learns what they missed", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    expect(voice.awaitingFirstWords()).toBe(true);
    voice.supersede();
    voice.delta("t1", "Got it, the store was closed. ");
    expect(await voice.deliver("Got it, the store was closed.", "t1")).toBe("silent");
    await settle();
    expect(queued).toEqual([]);
    expect(voice.takeCutOff()).toEqual({
      kind: "kept-talking",
      text: "Got it, the store was closed.",
    });
    // The next turn speaks normally.
    voice.beginTurn("t2");
    expect(await voice.deliver("So you came home. Makes sense.", "t2")).toBe("spoken");
  });

  test("once Edmund has started speaking, it is talking over him instead, not this", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "Sure thing. And");
    await settle();
    expect(queued.length).toBe(1);
    expect(voice.awaitingFirstWords()).toBe(false);
    voice.supersede();
    expect(await voice.deliver("Sure thing. And then", "t1")).toBe("spoken");
  });
});
