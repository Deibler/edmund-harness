import { describe, expect, test } from "bun:test";
import { buildEnvelope } from "../src/channels/envelope.ts";
import type { InboundMessage } from "../src/imessage/types.ts";

/**
 * Suggesting a skill at the moment of intent.
 *
 * Motivated by a measurement, not a hunch: over four months and ~2,600
 * conversational turns, skills were read on about 5% of turns, and 82% of
 * those reads were the four skills the system prompt names by hand
 * (instant-share, radaromega, radaromega-pro, kitchen). Eight skills were
 * never read once. Discovery was not happening; only hard-coded routing was.
 *
 * The failure mode of over-correcting is worse than the gap, so the tests
 * that matter here are the ones about restraint.
 */

function msg(text: string): InboundMessage {
  return {
    rowId: 1,
    msgGuid: "g1",
    chatGuid: "iMessage;-;+15550001111",
    chatIdentifier: "+15550001111",
    fromHandle: "+15550001111",
    text,
    isGroup: false,
    timestampMs: Date.now(),
    fromMe: false,
    attachmentTranscripts: {},
    service: "iMessage",
    attachments: [],
  } as unknown as InboundMessage;
}

function envelope(skillSuggestions: string[]): string {
  return buildEnvelope({
    messages: [msg("can you put together a shareable page for this")],
    senderLabel: "Regular",
    lastInboundMs: null,
    isGroup: false,
    pendingAttachments: 0,
    historyLines: [],
    transcripts: [],
    attachmentNotes: [],
    replies: [],
    recentReceived: [],
    reactionLines: [],
    skillSuggestions,
  } as never);
}

describe("the skill nudge", () => {
  test("names the skill and tells the model to read it before improvising", () => {
    const out = envelope(["instant-share"]);
    expect(out).toContain('read_skill("instant-share")');
    expect(out).toContain("before improvising");
  });

  test("is absent entirely when nothing matched", () => {
    // The common case by design. An empty block still costs prompt tokens on
    // every turn and teaches the model to skim past the section.
    const out = envelope([]);
    expect(out).not.toContain("read_skill(");
    expect(out).not.toContain("worked-out method");
  });

  test("gives the model explicit permission to ignore it", () => {
    // Without this a nudge reads as an instruction, and the model burns a
    // read_skill on a playbook that does not fit rather than answering.
    expect(envelope(["hike"])).toContain("ignore it and carry on");
  });
});
