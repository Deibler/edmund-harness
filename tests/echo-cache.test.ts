import { describe, expect, test } from "bun:test";
import { EchoCache, hashText } from "../src/sessions/echo-cache.ts";

describe("EchoCache", () => {
  test("matches a just-sent message by guid", () => {
    const c = new EchoCache();
    c.recordSent("hello there", "GUID-1");
    expect(c.isEcho("totally different text", "GUID-1")).toBe(true);
    expect(c.isEcho("hello there", "GUID-2")).toBe(true); // text fallback
    expect(c.isEcho("unseen", "GUID-2")).toBe(false);
  });

  test("text match is whitespace/case insensitive", () => {
    const c = new EchoCache();
    c.recordSent("Hey, what's up?");
    expect(c.isEcho("  hey, what's up?  ")).toBe(true);
    expect(c.isEcho("HEY, WHAT'S UP?")).toBe(true);
  });

  test("guid entry expires after its TTL", () => {
    const c = new EchoCache();
    const realNow = Date.now;
    try {
      let t = 1_000_000;
      Date.now = () => t;
      c.recordSent("x", "GUID-OLD");
      t += 59_000;
      expect(c.isEcho("nope", "GUID-OLD")).toBe(true); // still inside 60s
      t += 2_000;
      expect(c.isEcho("nope", "GUID-OLD")).toBe(false); // past 60s
    } finally {
      Date.now = realNow;
    }
  });

  test("text entry expires faster than guid (5s window)", () => {
    const c = new EchoCache();
    const realNow = Date.now;
    try {
      let t = 2_000_000;
      Date.now = () => t;
      c.recordSent("ping");
      t += 4_000;
      expect(c.isEcho("ping")).toBe(true);
      t += 2_000;
      expect(c.isEcho("ping")).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  test("hashText is stable and normalized", () => {
    expect(hashText("Hello\r\nWorld")).toBe(hashText("hello\nworld"));
    expect(hashText("a")).not.toBe(hashText("b"));
    expect(hashText("a")).toHaveLength(32);
  });
});
