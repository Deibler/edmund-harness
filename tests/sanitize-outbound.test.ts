import { describe, expect, test } from "bun:test";
import {
  isKeepQuiet,
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
    expect(isKeepQuiet("")).toBe(false);
  });
});
