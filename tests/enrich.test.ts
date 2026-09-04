/**
 * Pure tests for the buildEnrichedText helper. Covers every attachment
 * shape the indexer can produce: image, audio with/without transcript,
 * video, generic file, attachment-only message, multi-attachment.
 */
import { describe, expect, test } from "bun:test";
import { buildEnrichedText } from "../src/memory/enrich.ts";

describe("buildEnrichedText", () => {
  test("text-only message returns the text", () => {
    const r = buildEnrichedText({ text: "hello world", attachments: [] });
    expect(r).toBe("hello world");
  });

  test("trims whitespace", () => {
    expect(buildEnrichedText({ text: "   hello   ", attachments: [] })).toBe("hello");
  });

  test("attachment-only image with filename", () => {
    const r = buildEnrichedText({
      text: "",
      attachments: [{ filename: "/Users/me/IMG_0001.HEIC", mimeType: "image/heic" }],
    });
    expect(r).toBe("[image: IMG_0001.HEIC]");
  });

  test("audio with Apple on-device transcript", () => {
    const r = buildEnrichedText({
      text: "",
      attachments: [
        {
          filename: "/x/voice.m4a",
          mimeType: "audio/x-m4a",
          transcript: "running ten minutes late",
        },
      ],
    });
    expect(r).toBe("[voice memo: running ten minutes late]");
  });

  test("audio without transcript falls back to filename", () => {
    const r = buildEnrichedText({
      text: "",
      attachments: [{ filename: "/x/voice.m4a", mimeType: "audio/x-m4a", transcript: null }],
    });
    expect(r).toBe("[voice memo: voice.m4a]");
  });

  test("video", () => {
    const r = buildEnrichedText({
      text: "",
      attachments: [{ filename: "/x/IMG_1234.MOV", mimeType: "video/quicktime" }],
    });
    expect(r).toBe("[video: IMG_1234.MOV]");
  });

  test("generic file with mime type", () => {
    const r = buildEnrichedText({
      text: "",
      attachments: [{ filename: "/x/report.pdf", mimeType: "application/pdf" }],
    });
    expect(r).toBe("[file application/pdf: report.pdf]");
  });

  test("file with name but no mime", () => {
    const r = buildEnrichedText({
      text: "",
      attachments: [{ filename: "/x/notes.txt", mimeType: null }],
    });
    expect(r).toBe("[file: notes.txt]");
  });

  test("text + multiple attachments concatenated", () => {
    const r = buildEnrichedText({
      text: "check these out",
      attachments: [
        { filename: "/x/a.jpg", mimeType: "image/jpeg" },
        { filename: "/x/b.mov", mimeType: "video/quicktime" },
        {
          filename: "/x/c.m4a",
          mimeType: "audio/x-m4a",
          transcript: "this part is important",
        },
      ],
    });
    expect(r).toContain("check these out");
    expect(r).toContain("[image: a.jpg]");
    expect(r).toContain("[video: b.mov]");
    expect(r).toContain("[voice memo: this part is important]");
  });

  test("ignores attachments with no name and unknown mime", () => {
    const r = buildEnrichedText({
      text: "hi",
      attachments: [{ filename: null, mimeType: null }],
    });
    expect(r).toBe("hi");
  });

  test("transcript content is searchable text in the final string", () => {
    // The whole point of enrichment is that semantic search hits a
    // transcript. Verify the substring is present verbatim.
    const r = buildEnrichedText({
      text: "",
      attachments: [
        {
          filename: "/x/v.m4a",
          mimeType: "audio/x-m4a",
          transcript: "the pickup time changed to 3pm",
        },
      ],
    });
    expect(r).toContain("pickup time changed to 3pm");
  });
});
