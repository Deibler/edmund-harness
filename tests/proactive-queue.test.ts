/**
 * Tests for the brown-nose cron payload encoder/decoder.
 *
 * The systemEvent field carries `[BROWN_NOSE]<json>`. These tests
 * verify round-tripping and that malformed payloads decode to null
 * (so the standard envelope path takes over).
 */
import { describe, expect, test } from "bun:test";
import {
  BROWN_NOSE_PREFIX,
  decodeBrownNoseSystemEvent,
  isBrownNoseEvent,
} from "../src/proactive/queue.ts";

describe("BROWN_NOSE payload encoding", () => {
  test("isBrownNoseEvent detects the prefix", () => {
    expect(isBrownNoseEvent(`${BROWN_NOSE_PREFIX}{"brief":"x"}`)).toBe(true);
    expect(isBrownNoseEvent("Self-poke: anything")).toBe(false);
    expect(isBrownNoseEvent("")).toBe(false);
  });

  test("decode round-trips a full payload", () => {
    const payload = {
      brief: "Friday 4pm — Jordan mentioned hiking",
      tags: ["weekend", "weather"],
      expiresAtMs: 9999999999,
      ghostTickAtMs: 1234567890,
      confidence: "high",
    };
    const encoded = `${BROWN_NOSE_PREFIX}${JSON.stringify(payload)}`;
    const decoded = decodeBrownNoseSystemEvent(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.brief).toBe(payload.brief);
    expect(decoded!.tags).toEqual(payload.tags);
    expect(decoded!.expiresAtMs).toBe(payload.expiresAtMs);
    expect(decoded!.ghostTickAtMs).toBe(payload.ghostTickAtMs);
    expect(decoded!.confidence).toBe("high");
  });

  test("decode returns null for non-brown-nose events", () => {
    expect(decodeBrownNoseSystemEvent("Self-poke: foo")).toBeNull();
    expect(decodeBrownNoseSystemEvent("")).toBeNull();
  });

  test("decode returns null for malformed JSON", () => {
    expect(decodeBrownNoseSystemEvent(`${BROWN_NOSE_PREFIX}{not json}`)).toBeNull();
    expect(decodeBrownNoseSystemEvent(`${BROWN_NOSE_PREFIX}null`)).toBeNull();
  });

  test("decode returns null when required fields are missing", () => {
    // No brief
    expect(
      decodeBrownNoseSystemEvent(
        `${BROWN_NOSE_PREFIX}${JSON.stringify({ tags: [], expiresAtMs: 1, ghostTickAtMs: 1 })}`,
      ),
    ).toBeNull();
    // No expiresAtMs
    expect(
      decodeBrownNoseSystemEvent(
        `${BROWN_NOSE_PREFIX}${JSON.stringify({ brief: "x", tags: [], ghostTickAtMs: 1 })}`,
      ),
    ).toBeNull();
  });

  test("decode defaults confidence to 'low' for invalid values", () => {
    const encoded = `${BROWN_NOSE_PREFIX}${JSON.stringify({
      brief: "x",
      tags: [],
      expiresAtMs: 1,
      ghostTickAtMs: 1,
      confidence: "extreme", // invalid
    })}`;
    const decoded = decodeBrownNoseSystemEvent(encoded);
    expect(decoded!.confidence).toBe("low");
  });

  test("decode filters non-string tags", () => {
    const encoded = `${BROWN_NOSE_PREFIX}${JSON.stringify({
      brief: "x",
      tags: ["good", 42, null, "also good"],
      expiresAtMs: 1,
      ghostTickAtMs: 1,
    })}`;
    const decoded = decodeBrownNoseSystemEvent(encoded);
    expect(decoded!.tags).toEqual(["good", "also good"]);
  });
});
