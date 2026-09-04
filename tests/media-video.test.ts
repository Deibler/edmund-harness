/**
 * Video handling: kind classification, ffprobe parsing helpers, outbound
 * bitrate budgeting, STT backend selection, and the envelope's video
 * annotation precedence. The live ffmpeg round-trip (synthesized clip →
 * probe → transcode) runs only where ffmpeg exists — everywhere the daemon
 * actually runs — and self-skips otherwise.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildEnvelope } from "../src/channels/envelope.ts";
import type { Config } from "../src/config/config.ts";
import type { InboundMessage } from "../src/imessage/types.ts";
import { isAudioPath, isTranscribableMedia, isVideoPath } from "../src/media/media-kind.ts";
import { sttBackend } from "../src/media/transcribe.ts";
import {
  describeVideo,
  formatBytes,
  formatDuration,
  parseFps,
  probeVideo,
} from "../src/media/video-probe.ts";
import { maybePrepareVideoForSend, targetVideoKbps } from "../src/media/video-transcode.ts";

describe("media-kind", () => {
  test(".mp4 and .mov are video, not audio (the old drift bug)", () => {
    expect(isVideoPath("/x/clip.mp4")).toBe(true);
    expect(isVideoPath("/x/IMG_4312.MOV")).toBe(true);
    expect(isAudioPath("/x/clip.mp4")).toBe(false);
    expect(isAudioPath("/x/IMG_4312.MOV")).toBe(false);
  });
  test("voice-note formats are audio", () => {
    expect(isAudioPath("/x/note.caf")).toBe(true);
    expect(isAudioPath("/x/note.m4a")).toBe(true);
    expect(isVideoPath("/x/note.caf")).toBe(false);
  });
  test("transcribable = audio + video, not images/docs", () => {
    expect(isTranscribableMedia("/x/a.mov")).toBe(true);
    expect(isTranscribableMedia("/x/a.caf")).toBe(true);
    expect(isTranscribableMedia("/x/a.jpg")).toBe(false);
    expect(isTranscribableMedia("/x/a.pdf")).toBe(false);
  });
});

describe("video-probe helpers", () => {
  test("parseFps handles ratio, zero-den, garbage", () => {
    expect(parseFps("30000/1001")).toBeCloseTo(30, 0);
    expect(parseFps("0/0")).toBeNull();
    expect(parseFps(undefined)).toBeNull();
    expect(parseFps("nonsense")).toBeNull();
  });
  test("formatDuration and formatBytes read like a human wrote them", () => {
    expect(formatDuration(14.4)).toBe("0:14");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatBytes(18_200_000)).toBe("17.4 MB");
    expect(formatBytes(2048)).toBe("2 KB");
  });
  test("describeVideo composes available fields and skips missing ones", () => {
    expect(
      describeVideo({
        durationS: 14,
        width: 1080,
        height: 1920,
        videoCodec: "h264",
        audioCodec: "aac",
        hasAudio: true,
        sizeBytes: 18_200_000,
        fps: 30,
      }),
    ).toBe("0:14 · 1080×1920 · h264+aac · 17.4 MB");
    expect(
      describeVideo({
        durationS: null,
        width: null,
        height: null,
        videoCodec: null,
        audioCodec: null,
        hasAudio: false,
        sizeBytes: 1024,
        fps: null,
      }),
    ).toBe("1 KB");
  });
});

describe("targetVideoKbps", () => {
  test("fits the byte budget for the duration", () => {
    // 60s into 15MB: (15e6*8*0.93)/60/1000 - 128 ≈ 1732 kbps
    const kbps = targetVideoKbps(60, 15_000_000);
    expect(kbps).toBeGreaterThan(1_500);
    expect(kbps).toBeLessThan(2_000);
  });
  test("clamps to the floor for very long clips and the ceiling for tiny ones", () => {
    expect(targetVideoKbps(3_600)).toBe(700);
    expect(targetVideoKbps(2)).toBe(8_000);
  });
  test("unknown duration gets the middle-of-the-road default", () => {
    expect(targetVideoKbps(null)).toBe(2_500);
    expect(targetVideoKbps(0)).toBe(2_500);
  });
});

describe("sttBackend", () => {
  const cfg = (keys: Record<string, string>, sttModel = "whisper-1") =>
    ({ keys, tools: { stt_model: sttModel } }) as unknown as Config;

  test("prefers OpenRouter and maps legacy whisper-1 to the verified slug", () => {
    const b = sttBackend(cfg({ openrouter: "sk-or-x", openai: "sk-dead" }));
    expect(b).toEqual({ kind: "openrouter", apiKey: "sk-or-x", model: "openai/whisper-large-v3" });
  });
  test("a slash slug passes through verbatim", () => {
    const b = sttBackend(cfg({ openrouter: "sk-or-x" }, "mistralai/voxtral-mini-transcribe"));
    expect(b?.kind === "openrouter" && b.model).toBe("mistralai/voxtral-mini-transcribe");
  });
  test("falls back to OpenAI only when OpenRouter is absent; null with no keys", () => {
    expect(sttBackend(cfg({ openai: "sk-x" }))).toEqual({ kind: "openai", model: "whisper-1" });
    expect(sttBackend(cfg({}))).toBeNull();
  });
});

describe("envelope video annotations", () => {
  const inbound = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
    rowId: 1,
    msgGuid: "guid-1",
    chatIdentifier: "+15551234567",
    chatGuid: "chat-1",
    isGroup: false,
    fromHandle: "+15551234567",
    fromMe: false,
    text: "check this out",
    timestampMs: 1_700_000_000_000,
    attachments: ["/tmp/a.mov"],
    attachmentTranscripts: {},
    service: "iMessage",
    replyToGuid: null,
    ...overrides,
  });

  test("attachmentNotes wins over the bare transcript render for the same path", () => {
    const out = buildEnvelope({
      messages: [inbound()],
      senderLabel: "Pat",
      lastInboundMs: null,
      isGroup: false,
      transcripts: new Map([["/tmp/a.mov", "hi edmund"]]),
      attachmentNotes: new Map([["/tmp/a.mov", '[video: 0:14 · 1080×1920 — speech: "hi edmund"]']]),
    });
    expect(out).toContain('/tmp/a.mov [video: 0:14 · 1080×1920 — speech: "hi edmund"]');
    expect(out).not.toContain("[voice transcript:");
  });

  test("plain voice-note transcript render is unchanged", () => {
    const out = buildEnvelope({
      messages: [inbound({ attachments: ["/tmp/note.caf"] })],
      senderLabel: "Pat",
      lastInboundMs: null,
      isGroup: false,
      transcripts: new Map([["/tmp/note.caf", "call me back"]]),
    });
    expect(out).toContain('/tmp/note.caf [voice transcript: "call me back"]');
  });
});

describe("live ffmpeg round-trip", () => {
  const scratch = process.env.TMPDIR ?? "/tmp";
  const dir = join(scratch, "edmund-media-test");
  const ffmpegHere = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

  test("synthesized clip → probe reads real metadata → oversized transcode shrinks it", async () => {
    if (!ffmpegHere) return; // self-skip where ffmpeg is absent
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "synth.mov");
    // 2s of 640×360 noise-ish frames + a 440Hz tone, deliberately heavy
    // bitrate so the send guard has something to shrink.
    const gen = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=640x360:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:v",
        "libx264",
        "-b:v",
        "8M",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        src,
      ],
      { stdio: "ignore" },
    );
    expect(gen.status).toBe(0);

    const probe = await probeVideo(src);
    expect(probe).not.toBeNull();
    expect(probe!.width).toBe(640);
    expect(probe!.height).toBe(360);
    expect(probe!.videoCodec).toBe("h264");
    expect(probe!.hasAudio).toBe(true);
    expect(probe!.durationS).toBeGreaterThan(1.5);

    // Force a transcode by setting the budget below the source size.
    const budget = Math.floor(statSync(src).size / 2);
    const out = await maybePrepareVideoForSend(src, budget);
    expect(out).not.toBe(src);
    expect(existsSync(out)).toBe(true);
    expect(out.endsWith(".mp4")).toBe(true);
    // A within-budget, compatible file passes through untouched.
    const again = await maybePrepareVideoForSend(out, 100_000_000);
    expect(again).toBe(out);
  }, 30_000);
});
