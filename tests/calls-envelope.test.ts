/**
 * What the model is told on each turn of a call. The rules that depend on
 * the call (who dialled, what the line did for him) appear only when true.
 */
import { describe, expect, test } from "bun:test";
import { type CallEnvelopeInput, callEnvelopeBlock } from "../src/calls/envelope.ts";

const base: CallEnvelopeInput = {
  provider: "FaceTime",
  label: "Dana",
  isGroup: false,
  direction: "incoming",
  answeredAtMs: 1_000,
  nowMs: 61_000,
  cutOff: null,
};

describe("the call envelope", () => {
  test("asks for short turns, a short opening sentence and spoken numbers", () => {
    const block = callEnvelopeBlock(base);
    expect(block).toContain("[On a FaceTime call with Dana: 1 minute in]");
    expect(block).toContain("one or two short sentences");
    expect(block).toContain("Open with a short sentence");
    expect(block).toContain("the way they are said aloud");
  });

  test("mentions the line's own hmm only when the line has one", () => {
    expect(callEnvelopeBlock(base)).not.toContain('says a short "hmm" for you');
    expect(callEnvelopeBlock({ ...base, thinkingSounds: true })).toContain(
      'says a short "hmm" for you',
    );
  });

  test("voicemail is a thing only on a call he placed", () => {
    expect(callEnvelopeBlock(base)).not.toContain("voicemail");
    expect(callEnvelopeBlock({ ...base, direction: "outgoing" })).toContain("voicemail greeting");
  });

  // "(or anyone else)" was here, and a report for the person who asked for a
  // call was texted to the person called.
  test("says who send_message reaches, and what reaches anyone else", () => {
    const block = callEnvelopeBlock(base);
    expect(block).toContain("send_message texts Dana, the same person you are talking to");
    expect(block).toContain("It reaches no one else; message_contact");
    expect(block).not.toContain("or anyone else");
  });

  test("passes on what the line did for him", () => {
    const block = callEnvelopeBlock({ ...base, notes: ['the line said "Hello?" for you.'] });
    expect(block.split("\n").at(-1)).toBe('the line said "Hello?" for you.');
  });
});
