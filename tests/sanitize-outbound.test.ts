import { describe, expect, test } from "bun:test";
import {
  isKeepQuiet,
  keepQuietVeto,
  looksLikeIntentionalSilence,
  markdownToPlaintext,
  sanitizeOutbound,
  stripAITypography,
} from "../src/channels/sanitize-outbound.ts";

describe("stripAITypography", () => {
  test("em-dash becomes a comma-space", () => {
    expect(stripAITypography("yeah—totally")).toBe("yeah, totally");
    expect(stripAITypography("yeah — totally")).toBe("yeah, totally");
  });
  test("en-dash as a prose pause becomes a hyphen but ranges survive", () => {
    expect(stripAITypography("open 9–5 today")).toBe("open 9–5 today"); // no surrounding spaces -> untouched
    expect(stripAITypography("wait – what")).toBe("wait - what");
  });
  test("smart quotes and ellipsis are flattened", () => {
    expect(stripAITypography("“hi” and ‘bye’…")).toBe("\"hi\" and 'bye'...");
  });
  test("nbsp and double spaces collapse", () => {
    expect(stripAITypography("a b   c")).toBe("a b c");
  });
});

describe("markdownToPlaintext", () => {
  test("strips bold/italic/strike/code markers", () => {
    expect(markdownToPlaintext("**bold** and *italic* and ~~gone~~ and `code`")).toBe(
      "bold and italic and gone and code",
    );
  });
  test("headers lose their hashes", () => {
    expect(markdownToPlaintext("## Title\nbody")).toBe("Title\nbody");
  });
  test("links render as text (url)", () => {
    expect(markdownToPlaintext("see [the docs](https://x.com)")).toBe(
      "see the docs (https://x.com)",
    );
  });
  test("fenced code blocks are preserved verbatim", () => {
    const src = "before\n```\n**not bold**\n```\nafter";
    expect(markdownToPlaintext(src)).toBe(src);
  });
});

describe("looksLikeIntentionalSilence", () => {
  test("catches leading silence-statements", () => {
    for (const s of [
      "Silent, nothing owed.",
      "(no response needed)",
      "Staying quiet on this one.",
      "Group chat, not addressed to me.",
      "  *standing down* ",
    ]) {
      expect(looksLikeIntentionalSilence(s)).toBe(true);
    }
  });
  test("does not eat a real reply that mentions those words mid-text", () => {
    expect(looksLikeIntentionalSilence("Yeah no response needed from you, I got it handled")).toBe(
      false,
    );
  });
  test("long text is never treated as silence", () => {
    expect(looksLikeIntentionalSilence(`silent ${"x".repeat(200)}`)).toBe(false);
  });
  test("empty / punctuation-only is silence", () => {
    expect(looksLikeIntentionalSilence("   ...  ")).toBe(true);
    expect(looksLikeIntentionalSilence("")).toBe(true);
  });
});

describe("sanitizeOutbound", () => {
  test("strips thinking/scratchpad/memory blocks and role lines", () => {
    const raw = "<thinking>plan plan</thinking>assistant: Hey there\nWhat's up?";
    expect(sanitizeOutbound(raw)).toBe("Hey there\nWhat's up?");
    expect(sanitizeOutbound("<scratchpad>x</scratchpad>real reply")).toBe("real reply");
    expect(sanitizeOutbound("<relevant_memories>m</relevant_memories>hi")).toBe("hi");
  });
  test("collapses excessive blank lines and trims", () => {
    expect(sanitizeOutbound("a\n\n\n\nb\n\n")).toBe("a\n\nb");
  });
  test("returns empty string for silence-intent replies", () => {
    expect(sanitizeOutbound("Silent, nothing owed.")).toBe("");
  });
  test("applies typography fixes", () => {
    expect(sanitizeOutbound("sure—on it")).toBe("sure, on it");
  });
  test("drops the KEEP_QUIET veto sentinel to empty", () => {
    expect(sanitizeOutbound("KEEP_QUIET")).toBe("");
    expect(sanitizeOutbound("  KEEP_QUIET  ")).toBe("");
    expect(sanitizeOutbound("keep_quiet\n")).toBe("");
  });
  test("does not eat a real reply that merely mentions KEEP_QUIET", () => {
    expect(sanitizeOutbound("Reply with KEEP_QUIET to veto the message.")).toBe(
      "Reply with KEEP_QUIET to veto the message.",
    );
  });
  // The shape that shipped on 2026-09-19: a status note, then the sentinel on
  // its own line. The exact-match veto let the whole thing go out as a bubble.
  test("vetoes when the sentinel is the first or last line and drops the narration", () => {
    expect(sanitizeOutbound("Already answered in the thread, leaving it there.\nKEEP_QUIET")).toBe(
      "",
    );
    expect(sanitizeOutbound("Posted the frame.\n\nKEEP_QUIET\n")).toBe("");
    expect(sanitizeOutbound("KEEP_QUIET\n(no message needed)")).toBe("");
  });
  test("a sentinel line in the middle of a reply is not a veto", () => {
    const raw = "Two ways to stay silent:\nKEEP_QUIET\nor an empty reply.";
    expect(sanitizeOutbound(raw)).toBe(raw);
  });
});

describe("isKeepQuiet", () => {
  test("matches the bare sentinel regardless of case/whitespace", () => {
    expect(isKeepQuiet("KEEP_QUIET")).toBe(true);
    expect(isKeepQuiet("  KEEP_QUIET\n")).toBe(true);
    expect(isKeepQuiet("keep_quiet")).toBe(true);
  });
  test("rejects anything with extra words", () => {
    expect(isKeepQuiet("KEEP_QUIET for now")).toBe(false);
    expect(isKeepQuiet("ok KEEP_QUIET")).toBe(false);
    expect(isKeepQuiet("KEEP_QUIET.")).toBe(false);
    expect(isKeepQuiet("")).toBe(false);
  });
  test("honors the sentinel on the first or last line", () => {
    expect(isKeepQuiet("Posted.\nKEEP_QUIET")).toBe(true);
    expect(isKeepQuiet("keep_quiet\n\nnote to self")).toBe(true);
  });
});

describe("keepQuietVeto", () => {
  test("returns the narration the veto dropped", () => {
    expect(keepQuietVeto("Posted the frame.\nKEEP_QUIET")).toEqual({
      vetoed: true,
      narration: "Posted the frame.",
    });
    expect(keepQuietVeto("KEEP_QUIET")).toEqual({ vetoed: true, narration: "" });
    expect(keepQuietVeto("hello")).toEqual({ vetoed: false, narration: "" });
  });
});
