import { describe, expect, test } from "bun:test";
import {
  addressesEdmund,
  conversationIntent,
  stripInvocation,
} from "../integrations/mirror/src/utterance.ts";

/**
 * The Pi's wake gate is a 40MB Vosk model decoding against a grammar whose
 * whole vocabulary is the wake words plus "[unk]", judged on PARTIAL results
 * with no confidence floor. Ambient speech has almost nothing to decode onto,
 * so it lands on "edmund" — kitchen conversation and the Alexa in the same
 * room were reliably opening model turns.
 *
 * This is the second stage: the cheap detector decides whether to listen, a
 * real transcription model decides whether it was spoken to. Two directions
 * matter and they are not symmetric — a false accept wastes a turn, a false
 * reject silently swallows something he actually asked for.
 */
describe("addressesEdmund", () => {
  test("accepts the name however the transcriber spells it", () => {
    for (const heard of [
      "Edmund, what's the weather",
      "edmund whats the weather",
      "Hey Edmund, show me the news",
      "Edmond, turn on the lights",
      "Ed Mund, what time is it",
      "Admund what's on my calendar",
      "Edmunds, play something",
      "Edman, how long is the drive",
      "Admin, set a timer",
      "Edmun, remind me tonight",
    ]) {
      expect({ heard, addressed: addressesEdmund(heard) }).toEqual({ heard, addressed: true });
    }
  });

  test("accepts the name anywhere when it is spelled plainly", () => {
    // "stop, Edmund" is as much an address as "Edmund, stop".
    expect(addressesEdmund("stop talking Edmund")).toBe(true);
    expect(addressesEdmund("that's enough for now, Edmund")).toBe(true);
  });

  test("rejects the room talking to itself", () => {
    for (const heard of [
      "can you hand me the second one",
      "Alexa, set a timer for ten minutes",
      "let me know when you're done",
      "and then we can go to the store",
      "seven thirty tomorrow morning works",
      "I demand a recount",
      "she's a woman of her word",
      "the human genome project",
      "pass the almonds",
      "he's the admin on that account",
    ]) {
      expect({ heard, addressed: addressesEdmund(heard) }).toEqual({ heard, addressed: false });
    }
  });

  test("fuzziness does not extend past the opening of the line", () => {
    // The wake word lives in the pre-roll at the very start of a capture, so
    // a near-miss deep in a sentence is a word, not an address. Being generous
    // there is exactly what would let ordinary speech back through.
    expect(addressesEdmund("we should ask the admin about it tomorrow")).toBe(false);
    expect(addressesEdmund("the recipe calls for almond flour and butter")).toBe(false);
    // "admit" is a real word AND an observed mishearing, so it only counts
    // where the wake word actually sits.
    expect(addressesEdmund("Admit, what's the weather")).toBe(true);
    expect(addressesEdmund("you should just admit you were wrong")).toBe(false);
    // ...but a plainly spelled name still counts wherever it lands.
    expect(addressesEdmund("we should ask about it tomorrow Edmund")).toBe(true);
  });

  test("an empty or wordless capture is not an address", () => {
    expect(addressesEdmund("")).toBe(false);
    expect(addressesEdmund("   ...  ")).toBe(false);
  });
});

describe("stripInvocation", () => {
  test("removes the leading address and nothing else", () => {
    expect(stripInvocation("Edmund, what's the weather")).toBe("what's the weather");
    expect(stripInvocation("Hey Edmund show me the news")).toBe("show me the news");
    expect(stripInvocation("what's the weather")).toBe("what's the weather");
  });

  test("leaves a trailing address alone — it is part of the sentence", () => {
    expect(stripInvocation("stop talking Edmund")).toBe("stop talking Edmund");
  });
});

describe("conversationIntent", () => {
  test("separates leaving from cancelling from asking", () => {
    expect(conversationIntent("thanks")).toBe("bye");
    expect(conversationIntent("that's it for now")).toBe("bye");
    expect(conversationIntent("stop")).toBe("stop");
    expect(conversationIntent("cancel that, Edmund")).toBe("stop");
    expect(conversationIntent("find the song called Goodbye Yellow Brick Road")).toBe("message");
  });
});
