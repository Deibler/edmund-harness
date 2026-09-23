/**
 * Note sharing without a browser: who counts as already invited, and which
 * household principals can be invited at all.
 */

import { describe, expect, test } from "bun:test";
import { handlesFor, idKey } from "../src/notes_share.ts";

describe("recognising the same person twice", () => {
  test("the formatting iCloud applies does not make somebody look new", () => {
    // iCloud shows "+1 (555) 010-0001" for what was typed, so a literal
    // comparison would re-invite on every run.
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
    // A participant shown by name has no digits and must not match a number.
    expect(idKey("Edmund Bot")).not.toBe(idKey("+15550100001"));
  });

  test("and two different display names do not collide with each other", () => {
    // Names without digits must not all reduce to the same empty key: iCloud
    // shows contact names once an invite is accepted, so this is the norm.
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
