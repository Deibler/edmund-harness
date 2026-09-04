/**
 * The parts of note sharing that can be tested without a browser.
 *
 * The DOM driving cannot be unit tested — it is a real UI on somebody else's
 * site — so the value here is in pinning the two decisions that would silently
 * do damage if they drifted: who counts as already invited, and which household
 * principals are people you can actually invite.
 */

import { describe, expect, test } from "bun:test";
import { handlesFor, idKey } from "../src/notes_share.ts";

describe("recognising the same person twice", () => {
  test("the formatting iCloud applies does not make somebody look new", () => {
    // This is the whole reason idKey exists. iCloud renders what you typed as
    // "+1 (555) 010-0001"; a literal comparison would re-invite on every run.
    expect(idKey("+15550100001")).toBe(idKey("+1 (555) 010-0001"));
    expect(idKey("5550100001")).toBe(idKey("+1 (555) 010-0001"));
    expect(idKey("(555) 010-0001")).toBe(idKey("+15550100001"));
  });

  test("different people stay different", () => {
    expect(idKey("+15550100001")).not.toBe(idKey("+15550100004"));
  });

  test("email is case-insensitive but otherwise literal", () => {
    expect(idKey("Alex@Example.com")).toBe("alex@example.com");
    expect(idKey("a@b.com")).not.toBe(idKey("c@b.com"));
  });

  test("a display name never collides with a phone number", () => {
    // Participants can come back as "Edmund Bot" rather than a handle. That
    // has no digits, so it must not reduce to the same key as a bare number.
    expect(idKey("Edmund Bot")).not.toBe(idKey("+15550100001"));
  });

  test("and two different display names do not collide with each other", () => {
    // The bug this pins: names reduced to "" because they contain no digits, so
    // every person without a number in their label looked like every other one.
    // iCloud swaps a handle for a contact name the moment somebody accepts an
    // invite, so this is the steady state, not an edge case.
    expect(idKey("Alex Example")).not.toBe(idKey("Edmund Bot"));
    expect(idKey("Alex Example")).not.toBe("");
    expect(idKey("Alex Example")).toBe(idKey("  alex   example "));
  });
});

describe("who in a household can be invited", () => {
  test("group chats are dropped, because a group is a channel not a person", () => {
    expect(
      handlesFor(["imessage:dm:+15550100001", "imessage:group:abc123", "imessage:dm:+15550100004"]),
    ).toEqual(["+15550100001", "+15550100004"]);
  });

  test("emails come through", () => {
    expect(handlesFor(["imessage:dm:someone@example.com"])).toEqual(["someone@example.com"]);
  });

  test("anything that is not messageable is left out rather than guessed at", () => {
    expect(handlesFor(["mirror:pi4", "cli:local", "imessage:dm:"])).toEqual([]);
  });

  test("the same person twice is invited once", () => {
    expect(handlesFor(["imessage:dm:+15550100001", "sms:+15550100001"])).toEqual(["+15550100001"]);
  });
});
