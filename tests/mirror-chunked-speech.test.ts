import { describe, expect, test } from "bun:test";
import { speechChunks } from "../integrations/mirror/src/voice.ts";

describe("speechChunks", () => {
  test("keeps a single sentence whole", () => {
    expect(speechChunks("It is seventy two degrees and sunny in Lancaster.")).toEqual([
      "It is seventy two degrees and sunny in Lancaster.",
    ]);
  });

  test("splits on sentence ends and keeps the punctuation", () => {
    const chunks = speechChunks(
      "The forecast is clear through Sunday. Highs reach the upper seventies. " +
        "Rain arrives on Monday afternoon.",
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe("The forecast is clear through Sunday.");
    // Falling intonation depends on the terminator surviving the split.
    for (const chunk of chunks) expect(chunk).toMatch(/[.!?]$/);
  });

  test("never loses or reorders any of the reply", () => {
    const reply =
      "Good morning. It is seventy two degrees and sunny in Lancaster right now. " +
      "You have lunch with Pat at noon! Should I put the radar up?";
    const chunks = speechChunks(reply);
    expect(chunks.length).toBeGreaterThan(1);
    // Rejoining must reproduce the original modulo the whitespace we split on.
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(reply.replace(/\s+/g, " "));
  });

  test("folds a short fragment into its neighbour rather than speaking it alone", () => {
    // "Sure." on its own would be a request and an audible seam for one word.
    const chunks = speechChunks("Sure. The game starts at seven tonight against the Rangers.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Sure.");
  });

  test("respects the screen's audio queue bound without dropping text", () => {
    const reply = Array.from(
      { length: 20 },
      (_, i) => `This is sentence number ${i} and it is long enough to stand alone.`,
    ).join(" ");
    const chunks = speechChunks(reply, 8);
    expect(chunks.length).toBeLessThanOrEqual(8);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(reply.replace(/\s+/g, " "));
  });

  test("handles abbreviations and decimals without shattering", () => {
    const chunks = speechChunks("The high is 82.4 degrees today. Humidity sits near 48 percent.");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("82.4");
  });

  test("empty and whitespace-only replies produce nothing", () => {
    expect(speechChunks("")).toEqual([]);
    expect(speechChunks("   \n  ")).toEqual([]);
  });

  test("text with no terminator at all is still spoken", () => {
    expect(speechChunks("no punctuation here at all")).toEqual(["no punctuation here at all"]);
  });
});
