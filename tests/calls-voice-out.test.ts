/**
 * Edmund's speech on a call: what gets said, in what order, and what happens
 * when the caller talks over him or the call drops.
 */
import { describe, expect, test } from "bun:test";
import { VoiceOut, takeFirstClause } from "../src/calls/voice-out.ts";

type Said = { text: string; heard: boolean };

function harness(opts: { failSynthesis?: boolean; voice?: () => string } = {}) {
  const queued: { chunkId: string; text: string }[] = [];
  const said: Said[] = [];
  const kinds: string[] = [];
  const synthesized: string[] = [];
  let flushes = 0;
  const voice = new VoiceOut({
    speaker: {
      synthesize: async (text: string) => {
        synthesized.push(text);
        return opts.failSynthesis
          ? null
          : { pcm: new TextEncoder().encode(text), sampleRate: 24_000 };
      },
      ...(opts.voice ? { voiceKey: opts.voice } : {}),
    },
    onSpeaking: (kind) => kinds.push(kind),
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
  return { voice, queued, said, kinds, synthesized, flushes: () => flushes };
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
  test("a reply not yet begun is held; if they took their turn it goes unsaid, and the next turn learns what they missed", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    expect(voice.awaitingFirstWords()).toBe(true);
    voice.supersede();
    voice.delta("t1", "Got it, the store was closed. ");
    expect(await voice.deliver("Got it, the store was closed.", "t1")).toBe("silent");
    await settle();
    expect(queued).toEqual([]);
    expect(voice.holding()).toBe(true);
    voice.dropHeld();
    expect(voice.takeCutOff()).toEqual({
      kind: "kept-talking",
      text: "Got it, the store was closed.",
    });
    voice.beginTurn("t2");
    expect(await voice.deliver("So you came home. Makes sense.", "t2")).toBe("spoken");
  });

  test("if what they said was not a turn (background talk, a cough), the held reply is said after all", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.supersede();
    expect(await voice.deliver("Glad it works. Hi to Kayla.", "t1")).toBe("silent");
    voice.releaseHeld();
    await settle();
    expect(queued.map((q) => q.text).join(" ")).toBe("Glad it works. Hi to Kayla.");
    expect(voice.takeCutOff()).toBeNull();
  });

  test("released or dropped before the reply was written, it is decided when it arrives", async () => {
    const released = harness();
    released.voice.beginTurn("t1");
    released.voice.supersede();
    released.voice.releaseHeld();
    expect(await released.voice.deliver("Sure thing.", "t1")).toBe("spoken");

    const dropped = harness();
    dropped.voice.beginTurn("t1");
    dropped.voice.supersede();
    dropped.voice.dropHeld();
    expect(await dropped.voice.deliver("Sure thing.", "t1")).toBe("silent");
    expect(dropped.voice.takeCutOff()).toEqual({ kind: "kept-talking", text: "Sure thing." });
  });

  test("once Edmund has started speaking, it is talking over him instead, not this", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "Sure thing. And");
    await settle();
    expect(queued.length).toBe(1);
    expect(voice.awaitingFirstWords()).toBe(false);
    voice.supersede();
    expect(voice.holding()).toBe(false);
    expect(await voice.deliver("Sure thing. And then", "t1")).toBe("spoken");
  });
});

describe("a finished sentence before a pause in the text", () => {
  test("is said without waiting for the next sentence (or the tool call in between)", async () => {
    // "On it, texting you now." waited 4.8 s for send_message to be written
    // and sent, because a sentence was only known to end when the next began.
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "On it, texting you now.");
    await settle();
    expect(queued).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(queued.map((q) => q.text)).toEqual(["On it, texting you now."]);
    voice.delta("t1", " Sent.");
    expect(await voice.deliver("On it, texting you now. Sent.", "t1")).toBe("spoken");
    expect(queued.map((q) => q.text)).toEqual(["On it, texting you now.", "Sent."]);
  });

  test("an unfinished one is not said early", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", "So the thing about the");
    await new Promise((r) => setTimeout(r, 300));
    expect(queued).toEqual([]);
  });
});

describe("a long opening sentence", () => {
  const LONG =
    "Honestly, the easiest thing is to brown the chicken first, then add the stock and let it simmer for about twenty minutes.";

  test("is begun at its first clause worth saying, not held until its full stop", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", LONG.slice(0, 70));
    await settle();
    expect(queued.map((q) => q.text)).toEqual([
      "Honestly, the easiest thing is to brown the chicken first,",
    ]);
    voice.delta("t1", LONG.slice(70));
    await voice.deliver(LONG, "t1");
    expect(queued.map((q) => q.text).join(" ")).toBe(LONG);
  });

  test("only the opening is cut that way: later sentences are said whole", async () => {
    const { voice, queued } = harness();
    voice.beginTurn("t1");
    voice.delta("t1", `Sure. ${LONG.slice(0, 70)}`);
    await settle();
    expect(queued.map((q) => q.text)).toEqual(["Sure."]);
  });

  test("a short one is left alone, and so are times and numbers", () => {
    expect(takeFirstClause("Yeah, that works for me.")).toBeNull();
    // Long enough, but its only breaks are inside a time and a number.
    expect(
      takeFirstClause("The reservation I made for all of us is at 7:30 and it costs 82,400 yen"),
    ).toBeNull();
    expect(
      takeFirstClause("Well, I looked at the forecast for the weekend, and it is going to rain")
        ?.clause,
    ).toBe("Well, I looked at the forecast for the weekend,");
  });
});

describe("an aside", () => {
  test("is said into silence, and the reply follows it", async () => {
    const { voice, queued, kinds } = harness();
    voice.beginTurn("t1");
    expect(voice.aside("Hmm.")).toBe(true);
    // It is not the reply beginning: a caller who talks now still has the reply held.
    expect(voice.awaitingFirstWords()).toBe(true);
    voice.delta("t1", "Tacos. ");
    await voice.deliver("Tacos.", "t1");
    expect(queued.map((q) => q.text)).toEqual(["Hmm.", "Tacos."]);
    expect(kinds).toEqual(["aside", "reply"]);
  });

  test("is never said over Edmund, into a held line, or once his reply has begun", async () => {
    const speaking = harness();
    await speaking.voice.deliver("The agent finished.");
    expect(speaking.voice.aside("Hmm.")).toBe(false);

    const ringing = harness();
    ringing.voice.hold();
    expect(ringing.voice.aside("Hello?")).toBe(false);

    const begun = harness();
    begun.voice.beginTurn("t1");
    begun.voice.delta("t1", "Sure thing. Give me");
    expect(begun.voice.aside("Hmm.")).toBe(false);
    await settle();
    expect(begun.queued.map((q) => q.text)).toEqual(["Sure thing."]);
  });

  test("talked over, it is stopped and the reply is held for them, with nothing noted as missed", async () => {
    const { voice, queued, flushes } = harness();
    voice.beginTurn("t1");
    voice.aside("Hmm.");
    await settle();
    expect(queued.map((q) => q.text)).toEqual(["Hmm."]);
    await voice.bargeIn();
    expect(flushes()).toBe(1);
    expect(voice.holding()).toBe(true);
    expect(await voice.deliver("The store closes at nine.", "t1")).toBe("silent");
    voice.dropHeld();
    expect(voice.takeCutOff()).toEqual({ kind: "kept-talking", text: "The store closes at nine." });
  });

  test("prepared ahead, it is synthesised once; in a new voice, again", async () => {
    let current = "am_fenrir@1";
    const { voice, queued, synthesized } = harness({ voice: () => current });
    voice.prepare("Hello?");
    voice.prepare("Hello?");
    expect(voice.aside("Hello?")).toBe(true);
    await settle();
    expect(synthesized).toEqual(["Hello?"]);
    voice.onSpoken(queued[0]!.chunkId, true);

    current = "bm_daniel@1"; // call_voice: a line kept in the old voice is not his any more
    expect(voice.aside("Hello?")).toBe(true);
    await settle();
    expect(synthesized).toEqual(["Hello?", "Hello?"]);
  });

  test("has spoken only once something was handed over to play", async () => {
    const { voice } = harness();
    expect(voice.hasSpoken()).toBe(false);
    voice.aside("Hello?");
    await settle();
    expect(voice.hasSpoken()).toBe(true);
  });
});
