import { describe, expect, test } from "bun:test";
import { decodeMessageText } from "../src/imessage/decode.ts";

/**
 * Build a typedstream-shaped attributedBody:
 *
 *   <head><class trailer><NSString><class trailer><length-prefix><utf8 text><tail>
 *
 * The length-prefix follows the real typedstream varint format the decoder
 * parses (1-byte if len ≤ 0x80, else 0x81 + uint16LE). `trailerBytes` is
 * the class-version filler past the "NSString" marker that the decoder
 * scans through (1..32 bytes). Real macOS payloads vary in this width
 * across iMessage versions — the decoder tries every offset.
 */
function fakeAttributedBody(text: string, trailerBytes = 4): Uint8Array {
  const head = new TextEncoder().encode("\x84\x84streamtyped\x00\x00garbageNSString");
  const trailer = new Uint8Array(trailerBytes).fill(0x84);
  const utf8 = new TextEncoder().encode(text);
  // typedstream varint length prefix.
  let prefix: Uint8Array;
  if (utf8.length <= 0x80) {
    prefix = new Uint8Array([utf8.length]);
  } else {
    prefix = new Uint8Array([0x81, utf8.length & 0xff, (utf8.length >> 8) & 0xff]);
  }
  const tail = new Uint8Array([0x86, 0x84, 0x00, 0x00]);
  return new Uint8Array([...head, ...trailer, ...prefix, ...utf8, ...tail]);
}

/**
 * Build an attachment-shaped attributedBody. Apple stores the visible
 * "string" of an attachment as a U+FFFC object-replacement placeholder,
 * followed by an attributes NSDictionary carrying the file-transfer GUID:
 *
 *   ...NSString <caption?+U+FFFC> "NSDictionary" "__kIMFileTransferGUID..."
 *
 * With no caption the backing string is a lone U+FFFC, and the next readable
 * token is the "NSDictionary" class name — the exact shape that used to make
 * the decoder surface a phantom "NSDictionary" (later "iI") as message text.
 */
function fakeAttachmentBody(caption = "", trailerBytes = 4): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode("\x84\x84streamtyped\x00\x00garbageNSString");
  const trailer = new Uint8Array(trailerBytes).fill(0x84);
  const backing = enc.encode(`${caption}￼`);
  const bprefix =
    backing.length <= 0x80
      ? new Uint8Array([backing.length])
      : new Uint8Array([0x81, backing.length & 0xff, (backing.length >> 8) & 0xff]);
  const lenTok = (s: string) => {
    const b = enc.encode(s);
    return new Uint8Array([b.length, ...b]);
  };
  const tail = new Uint8Array([0x86, 0x84, 0x00, 0x00]);
  // Object/class framing opcodes that sit between the backing string and the
  // attributes dictionary in a real payload. 0x86/0x84 are invalid UTF-8 lead
  // bytes, so they break any misaligned read that would otherwise span from
  // the caption into the "NSDictionary" token (an artifact of a too-tightly-
  // packed fixture, not the decoder).
  const sep = new Uint8Array([0x86, 0x84, 0x01]);
  return new Uint8Array([
    ...head,
    ...trailer,
    ...bprefix,
    ...backing,
    ...sep,
    ...lenTok("NSDictionary"),
    ...sep,
    ...lenTok("__kIMFileTransferGUIDAttributeName"),
    ...tail,
  ]);
}

describe("decodeMessageText", () => {
  test("returns plain text when present", () => {
    expect(decodeMessageText("hello world", null)).toBe("hello world");
    expect(decodeMessageText("plain wins", fakeAttributedBody("archived"))).toBe("plain wins");
  });

  test("empty string for nothing decodable", () => {
    expect(decodeMessageText(null, null)).toBe("");
    expect(decodeMessageText("", null)).toBe("");
    expect(decodeMessageText(null, new Uint8Array([1, 2, 3, 4, 5]))).toBe("");
  });

  test("extracts the string after the NSString marker", () => {
    const got = decodeMessageText(null, fakeAttributedBody("hey can you grab milk"));
    expect(got).toBe("hey can you grab milk");
  });

  test("handles unicode in the archived text", () => {
    const got = decodeMessageText(null, fakeAttributedBody("café ☕ déjà vu"));
    expect(got).toBe("café ☕ déjà vu");
  });

  test("preserves emoji including surrogate pairs", () => {
    // Pre-2026-05 bug: the regex hack dropped the first byte of every
    // emoji, producing replacement chars and corrupted neighbors.
    const got = decodeMessageText(null, fakeAttributedBody("yo 👍 going 🎣 on the bay 🌊"));
    expect(got).toBe("yo 👍 going 🎣 on the bay 🌊");
  });

  test("does not bleed typedstream framing bytes into the result", () => {
    // The length prefix should make the slice exact; trailer bytes never
    // appear in the decoded string.
    const got = decodeMessageText(null, fakeAttributedBody("clean text"));
    expect(got).toBe("clean text");
    expect(got).not.toContain("NSString");
  });

  test("tolerates a couple of different prefix offsets", () => {
    for (const skip of [1, 4, 8, 16, 24]) {
      const got = decodeMessageText(null, fakeAttributedBody("offset test", skip));
      expect(got).toBe("offset test");
    }
  });

  test("handles long messages via 0x81 16-bit length prefix", () => {
    const long = "a".repeat(500);
    const got = decodeMessageText(null, fakeAttributedBody(long));
    expect(got).toBe(long);
  });

  test("attachment-only message decodes to empty, not a class-token phantom", () => {
    // Regression: an image with no caption used to surface "NSDictionary"
    // (then "iI") as its text, polluting the envelope and recall index.
    const got = decodeMessageText(null, fakeAttachmentBody());
    expect(got).toBe("");
    expect(got).not.toContain("NSDictionary");
  });

  test("attachment WITH a caption keeps the caption", () => {
    expect(decodeMessageText(null, fakeAttachmentBody("Punishment"))).toBe("Punishment");
    expect(decodeMessageText(null, fakeAttachmentBody("look at this 🎣"))).toBe("look at this 🎣");
  });
});
