import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLACEHOLDER_TEXT,
  compactSession,
  sessionFilePath,
} from "../src/claude/session-compact.ts";

/**
 * Build a synthetic session JSONL with N image blocks of approximately
 * `dataBytesPerImage` base64 bytes each. The shape mirrors what Claude
 * Code actually writes: one record per turn, with `message.content` an
 * array of content blocks.
 */
function makeFixture(
  dir: string,
  imageCount: number,
  dataBytesPerImage: number,
  extraTextRecords = 0,
): string {
  const path = join(dir, "session.jsonl");
  const lines: string[] = [];
  // Mix in some non-image text records too, so we can verify they're not
  // touched.
  for (let t = 0; t < extraTextRecords; t++) {
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: `hello number ${t}` }],
        },
      }),
    );
  }
  for (let i = 0; i < imageCount; i++) {
    const data = "A".repeat(dataBytesPerImage);
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: `image turn ${i}` },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
          ],
        },
      }),
    );
    // Assistant ack record between user turns
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `ack ${i}` }],
        },
      }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function countImagesOnDisk(path: string): number {
  let n = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      const visit = (o: unknown): void => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) {
          for (const v of o) visit(v);
          return;
        }
        const obj = o as Record<string, unknown>;
        if (
          obj.type === "image" &&
          obj.source &&
          typeof obj.source === "object" &&
          (obj.source as Record<string, unknown>).type === "base64"
        ) {
          n++;
        }
        for (const v of Object.values(obj)) visit(v);
      };
      visit(rec);
    } catch {}
  }
  return n;
}

describe("sessionFilePath", () => {
  test("encodes the sandbox cwd into the Claude projects slug", () => {
    const p = sessionFilePath("/Users/example/edmund-harness/sandbox/dm_+1555", "abc-123");
    expect(p).toContain("/.claude/projects/");
    expect(p).toContain("-Users-example-edmund-harness-sandbox-dm--1555");
    expect(p.endsWith("abc-123.jsonl")).toBe(true);
  });
});

describe("compactSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "compact-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("no-op when file is missing", () => {
    const r = compactSession(join(dir, "nope.jsonl"), 1_000);
    expect(r.changed).toBe(false);
    expect(r.beforeBytes).toBe(0);
  });

  test("no-op when file already under target", () => {
    const path = makeFixture(dir, 3, 100);
    const before = statSync(path).size;
    const r = compactSession(path, before + 1_000);
    expect(r.changed).toBe(false);
    expect(r.imagesCompacted).toBe(0);
    expect(statSync(path).size).toBe(before);
  });

  test("shrinks the file below the target by replacing oldest images first", () => {
    // 10 images at 100 KB each ≈ 1 MB total. Target = 300 KB → ~7 images
    // need to be compacted.
    const path = makeFixture(dir, 10, 100_000);
    const beforeBytes = statSync(path).size;
    const target = 300_000;
    const r = compactSession(path, target);

    expect(r.changed).toBe(true);
    expect(r.beforeBytes).toBe(beforeBytes);
    expect(r.afterBytes).toBeLessThanOrEqual(target);
    expect(r.imagesCompacted).toBeGreaterThan(0);
    expect(r.imagesCompacted).toBeLessThanOrEqual(r.totalImages);
    expect(r.totalImages).toBe(10);
  });

  test("compacts oldest images first (FIFO order)", () => {
    const path = makeFixture(dir, 5, 200_000);
    const target = 400_000;
    compactSession(path, target);

    const records = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // The fixture lays out: user-with-image, assistant-ack, user-with-image,
    // assistant-ack, ... — so user records at even indices. The earliest
    // user records should have their image replaced with the placeholder,
    // while the latest should still hold a real base64 image.
    const userRecords = records.filter((r) => r.type === "user");
    expect(userRecords.length).toBe(5);

    // Find first index whose image is still a base64 block.
    let firstStillImage = -1;
    for (let i = 0; i < userRecords.length; i++) {
      const blocks = userRecords[i].message.content as Array<{
        type: string;
        source?: { type: string };
      }>;
      const img = blocks.find((b) => b.type === "image");
      if (img && img.source?.type === "base64") {
        firstStillImage = i;
        break;
      }
    }
    expect(firstStillImage).toBeGreaterThan(0); // at least one earlier was elided
  });

  test("non-image content is untouched", () => {
    const path = makeFixture(dir, 5, 100_000, /* extraTextRecords */ 3);
    compactSession(path, 200_000);

    const records = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // The 3 extra text records should still be present and unchanged.
    const textOnly = records.filter(
      (r) =>
        r.message?.content?.length === 1 &&
        r.message.content[0].type === "text" &&
        r.message.content[0].text?.startsWith("hello number"),
    );
    expect(textOnly.length).toBe(3);
  });

  test("placeholder content blocks land where images were", () => {
    const path = makeFixture(dir, 4, 200_000);
    compactSession(path, 100_000); // very aggressive — all should compact

    const txt = readFileSync(path, "utf8");
    expect(txt).toContain(PLACEHOLDER_TEXT);
    // No base64 image content blocks should remain.
    expect(countImagesOnDisk(path)).toBe(0);
  });

  test("idempotent: second call on already-compact file is a no-op", () => {
    const path = makeFixture(dir, 8, 200_000);
    const first = compactSession(path, 500_000);
    expect(first.changed).toBe(true);
    const sizeAfterFirst = statSync(path).size;

    const second = compactSession(path, 500_000);
    expect(second.changed).toBe(false);
    expect(statSync(path).size).toBe(sizeAfterFirst);
  });

  test("preserves file mode (0600)", () => {
    const path = makeFixture(dir, 5, 200_000);
    const { chmodSync } = require("node:fs");
    chmodSync(path, 0o600);
    compactSession(path, 300_000);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("malformed lines are skipped, not crashed on", () => {
    const path = join(dir, "session.jsonl");
    const valid = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "A".repeat(500_000) },
          },
        ],
      },
    });
    writeFileSync(path, `not-json\n${valid}\nalso-not-json\n`);
    const r = compactSession(path, 100_000);
    expect(r.changed).toBe(true);
    expect(r.imagesCompacted).toBe(1);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("not-json");
    expect(after).toContain("also-not-json");
    expect(after).toContain(PLACEHOLDER_TEXT);
  });
});
