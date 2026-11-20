/**
 * The transcriber is loaded for calls and let go between them. Against a
 * stand-in for its python that speaks the same line protocol.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcriber } from "../src/voice/transcriber.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pcm = new Uint8Array(320);

let dir: string;
let python: string;
let transcriber: Transcriber | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edmund-transcriber-"));
  python = join(dir, "python3");
  writeFileSync(
    python,
    [
      "#!/bin/sh",
      `echo '{"id":"boot","ok":true,"ms":1}'`,
      "while read -r line; do",
      `  id=$(printf '%s' "$line" | sed -E 's/.*"id":"([^"]+)".*/\\1/')`,
      `  echo "{\\"id\\":\\"$id\\",\\"ok\\":true,\\"text\\":\\"hello\\",\\"ms\\":1}"`,
      "done",
    ].join("\n"),
  );
  chmodSync(python, 0o755);
});

afterEach(() => {
  transcriber?.stop();
  transcriber = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("transcriber idle unload", () => {
  test("is let go once it has been quiet, and loads again for the next request", async () => {
    transcriber = new Transcriber({ python, idleUnloadMs: 80 });
    expect(await transcriber.start()).toBe(true);
    expect(transcriber.ready()).toBe(true);
    await wait(250);
    expect(transcriber.ready()).toBe(false);
    expect((await transcriber.transcribe(pcm))?.text).toBe("hello");
    expect(transcriber.ready()).toBe(true);
  });

  test("is never let go while a call is live, however quiet the caller", async () => {
    let onCall = true;
    transcriber = new Transcriber({ python, idleUnloadMs: 60, inUse: () => onCall });
    expect(await transcriber.start()).toBe(true);
    await wait(300);
    expect(transcriber.ready()).toBe(true);
    onCall = false;
    await wait(200);
    expect(transcriber.ready()).toBe(false);
  });

  test("a request starts the quiet time over", async () => {
    transcriber = new Transcriber({ python, idleUnloadMs: 200 });
    expect(await transcriber.start()).toBe(true);
    for (let i = 0; i < 4; i++) {
      await wait(120);
      expect((await transcriber.transcribe(pcm))?.text).toBe("hello");
    }
    expect(transcriber.ready()).toBe(true);
  });

  test("stays loaded for good when no idle time is given", async () => {
    transcriber = new Transcriber({ python });
    expect(await transcriber.start()).toBe(true);
    await wait(200);
    expect(transcriber.ready()).toBe(true);
  });
});
