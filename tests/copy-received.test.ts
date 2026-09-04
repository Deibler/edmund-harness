import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "../src/imessage/types.ts";
import { copyReceivedAttachments } from "../src/persona/copy-received.ts";

let dir: string;

function msg(attachments: string[], rowId = 1): InboundMessage {
  return {
    rowId,
    msgGuid: `g${rowId}`,
    chatIdentifier: "+15550000000",
    chatGuid: "iMessage;-;+15550000000",
    isGroup: false,
    fromHandle: "+15550000000",
    fromMe: false,
    text: "",
    timestampMs: Date.UTC(2026, 4, 12, 10, 0, 0),
    attachments,
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-copyrcv-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("copyReceivedAttachments", () => {
  test("copies already-present files into the sandbox", async () => {
    const sandbox = join(dir, "sandbox");
    const a = join(dir, "a.png");
    const b = join(dir, "b.jpg");
    writeFileSync(a, "AAA");
    writeFileSync(b, "BBB");

    const { copied, pending } = await copyReceivedAttachments(sandbox, [msg([a, b])]);
    expect(pending).toEqual([]);
    expect(copied.size).toBe(2);
    for (const dest of copied.values()) {
      expect(existsSync(dest)).toBe(true);
    }
    expect(readFileSync(copied.get(a)!, "utf8")).toBe("AAA");
  });

  test("a never-materializing path lands in pending, others still copy", async () => {
    const sandbox = join(dir, "sandbox");
    const good = join(dir, "good.png");
    const ghost = join(dir, "ghost.png"); // never created
    writeFileSync(good, "G");

    const { copied, pending } = await copyReceivedAttachments(sandbox, [msg([good, ghost])], {
      waitTimeoutMs: 600,
    });
    expect([...copied.keys()]).toEqual([good]);
    expect(pending).toEqual([ghost]);
  });

  test("dedups a path that appears in two messages", async () => {
    const sandbox = join(dir, "sandbox");
    const p = join(dir, "shared.png");
    writeFileSync(p, "S");
    const { copied } = await copyReceivedAttachments(sandbox, [msg([p], 1), msg([p], 2)]);
    expect(copied.size).toBe(1);
    expect(copied.has(p)).toBe(true);
  });

  test("waits for the slower files in parallel, not in series", async () => {
    const sandbox = join(dir, "sandbox");
    const a = join(dir, "slow-a.png");
    const b = join(dir, "slow-b.png");
    const c = join(dir, "slow-c.png");
    // Each appears after ~1.2s. Serial waits would total ~3.6s+; parallel ~1.2s.
    for (const p of [a, b, c]) {
      setTimeout(() => writeFileSync(p, p), 1200);
    }
    const t0 = Date.now();
    const { copied, pending } = await copyReceivedAttachments(sandbox, [msg([a, b, c])]);
    const elapsed = Date.now() - t0;
    expect(pending).toEqual([]);
    expect(copied.size).toBe(3);
    // Parallel waits finish in ~2s (1.2s appear + a poll cycle to confirm
    // size-stable); serial would be ~3.4s+. 3s leaves headroom for the test
    // runner being busy without letting a regression to serial slip through.
    expect(elapsed).toBeLessThan(3000);
  }, 15_000);

  test("returns empty result when there are no attachments", async () => {
    const { copied, pending } = await copyReceivedAttachments(join(dir, "s"), [msg([])]);
    expect(copied.size).toBe(0);
    expect(pending).toEqual([]);
  });
});
