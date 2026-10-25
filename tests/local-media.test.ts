import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passesGroupRegate } from "../src/channels/turn.ts";
import { ConfigSchema } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import {
  cleanWhisperText,
  localSttBackend,
  sttBackends,
  transcribeMediaFile,
} from "../src/media/transcribe.ts";
import { describeWatch, framePlan, watchVideoLocally } from "../src/media/video-watch.ts";

const dir = mkdtempSync(join(tmpdir(), "local-media-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** A stand-in for whisper-cli that prints a fixed transcript, or fails. */
function fakeWhisper(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function config(tools: Record<string, unknown>, keys: Record<string, string> = {}) {
  return ConfigSchema.parse({
    self: { handles: [] },
    allowlist: {},
    identity: {},
    keys,
    paths: { data_dir: dir },
    tools,
  });
}

const model = join(dir, "ggml-test.bin");
writeFileSync(model, "not a real model");

describe("speech-to-text runs locally first", () => {
  test("a present model and binary make local the first backend, before hosted", () => {
    const bin = fakeWhisper("whisper-ok", "echo hi");
    const c = config({ local_stt_model: model, whisper_cli: bin }, { openrouter: "k" });
    expect(sttBackends(c).map((b) => b.kind)).toEqual(["local", "openrouter"]);
  });

  test("a relative model path resolves against the data dir", () => {
    const bin = fakeWhisper("whisper-rel", "echo hi");
    expect(
      localSttBackend(config({ local_stt_model: "ggml-test.bin", whisper_cli: bin }))?.model,
    ).toBe(model);
  });

  test("a missing model or binary leaves only hosted backends", () => {
    const bin = fakeWhisper("whisper-x", "echo hi");
    expect(
      localSttBackend(config({ local_stt_model: join(dir, "absent.bin"), whisper_cli: bin })),
    ).toBeNull();
    expect(
      localSttBackend(config({ local_stt_model: model, whisper_cli: join(dir, "absent") })),
    ).toBeNull();
    expect(
      sttBackends(config({ local_stt_model: "" }, { openrouter: "k" })).map((b) => b.kind),
    ).toEqual(["openrouter"]);
  });

  test("whisper's non-speech tags are not words", () => {
    expect(cleanWhisperText(" [BLANK_AUDIO]\n")).toBe("");
    expect(cleanWhisperText(" (music)\n [Music] ")).toBe("");
    expect(cleanWhisperText(" Hey Edmund,\n can you check the charger? [BLANK_AUDIO]")).toBe(
      "Hey Edmund, can you check the charger?",
    );
  });

  test.skipIf(!hasFfmpeg)("a voice note is transcribed by the local binary", async () => {
    const wav = join(dir, "note.wav");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", wav]);
    const bin = fakeWhisper("whisper-says", 'echo " Edmund, remind me at noon."');
    const text = await transcribeMediaFile(
      wav,
      config({ local_stt_model: model, whisper_cli: bin }),
    );
    expect(text).toBe("Edmund, remind me at noon.");
  });

  test.skipIf(!hasFfmpeg)(
    "a failing local binary falls through, and the error is real",
    async () => {
      const wav = join(dir, "note2.wav");
      spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", wav]);
      const bin = fakeWhisper("whisper-broken", "echo boom >&2; exit 3");
      await expect(
        transcribeMediaFile(wav, config({ local_stt_model: model, whisper_cli: bin })),
      ).rejects.toThrow(/exit 3/);
    },
  );
});

describe("watching a video with the model's own eyes", () => {
  test("frames are about one a second, at least six, capped", () => {
    expect(framePlan(20)).toHaveLength(20);
    expect(framePlan(2)).toHaveLength(6);
    expect(framePlan(600)).toHaveLength(36);
    expect(framePlan(600, true)).toHaveLength(81);
    expect(framePlan(null)).toHaveLength(9);
    const t = framePlan(20);
    expect(t[0]).toBe(0);
    expect(t[19]).toBe(19);
  });

  test.skipIf(!hasFfmpeg)("a clip becomes contact sheets plus a transcript", async () => {
    const mp4 = join(dir, "clip.mp4");
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=12:size=640x360:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=12",
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      mp4,
    ]);
    const bin = fakeWhisper("whisper-clip", 'echo " This is the clip."');
    const w = await watchVideoLocally(mp4, config({ local_stt_model: model, whisper_cli: bin }));
    expect(w.sheets).toHaveLength(2);
    for (const s of w.sheets) {
      expect(existsSync(s.path)).toBe(true);
      expect(readFileSync(s.path).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }
    expect(w.sheets[0]?.times).toHaveLength(9);
    expect(w.sheets[1]?.times).toHaveLength(3);
    expect(w.transcript).toBe("This is the clip.");
    const text = describeWatch(w, "what is on screen?");
    expect(text).toContain("Sheet 2: frames at 0:09.0, 0:10.0, 0:11.0");
    expect(text).toContain("Audio transcript: This is the clip.");
    expect(text).toContain("what is on screen?");
  });

  test("the video tool watches locally unless a hosted model is named", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/mcp/tools/video.ts"), "utf8");
    expect(src).toContain("watchVideoLocally(args.file_path");
    expect(src).toContain('if (args.model?.includes("/"))');
    expect(src).not.toContain("hasVideoAnalysisBackend");
  });
});

describe("an untranscribable group voice note is not dropped", () => {
  const voice = {
    rowId: 1,
    guid: "g1",
    text: "",
    fromHandle: "+15555550101",
    fromMe: false,
    isGroup: true,
    chatGuid: "any;+;chat1",
    chatIdentifier: "chat1",
    timestampMs: 1,
    attachments: ["/tmp/voice.caf"],
    attachmentTranscripts: {},
  } as unknown as InboundMessage;

  test("no transcript and no failure: not addressed", () => {
    expect(passesGroupRegate([voice], [], ["edmund"])).toBe(false);
  });

  test("a failed transcription goes to the model to decide", () => {
    expect(passesGroupRegate([voice], [], ["edmund"], 1)).toBe(true);
  });

  test("turn.ts passes the failure count through", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src/channels/turn.ts"), "utf8");
    expect(src).toContain("mediaEnrichment.failed.length,");
    expect(src).toContain("sttBackend(config) !== null");
  });
});
