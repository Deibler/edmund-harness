/**
 * How a FaceTime call is heard: the call-audio helper streams the tap's PCM
 * and the provider's Ear hears it, the same Ear as the voice lab. Driven
 * through real sockets by a fake helper; nothing native is launched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { type Socket, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FaceTimeProvider } from "../src/calls/providers/facetime/provider.ts";
import type { ProviderEvent } from "../src/calls/types.ts";

/** The helper's end of the audio socket: answers requests, sends events. */
class FakeHelper {
  readonly requests: string[] = [];
  /** What it answers to "status"; the permission is read from it each time. */
  status: Record<string, unknown> = { capture: "granted" };
  private socket: Socket;
  private buffer = "";
  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        const message = JSON.parse(this.buffer.slice(0, i));
        this.buffer = this.buffer.slice(i + 1);
        if (message.method !== "status") this.requests.push(message.method);
        const result = message.method === "status" ? this.status : true;
        this.send({ id: message.id, ok: true, result });
      }
    });
  }
  static async dial(path: string, hello: Record<string, unknown>): Promise<FakeHelper> {
    const socket = connect(path);
    await new Promise((resolve) => socket.once("connect", resolve));
    const helper = new FakeHelper(socket);
    helper.send({ event: "hello", pid: 1, guard: [], ...hello });
    return helper;
  }
  send(message: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }
  /** Audio as the tap sends it: 20 ms buffers. */
  audio(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i += 320) {
      const frame = samples.slice(i, i + 320);
      this.send({ event: "audio", pcm: Buffer.from(frame.buffer).toString("base64") });
    }
  }
  close(): void {
    this.socket.destroy();
  }
}

const talk = (ms: number) => {
  const out = new Int16Array(ms * 16);
  for (let i = 0; i < out.length; i++) out[i] = Math.round((Math.random() * 2 - 1) * 5_000);
  return out;
};
const quiet = (ms: number) => new Int16Array(ms * 16);

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir = "";
let provider: FaceTimeProvider | null = null;
afterEach(async () => {
  await provider?.stop();
  provider = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function setUp(options: { audioStallMs?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "ft-hear-"));
  const events: ProviderEvent[] = [];
  const transcribed: number[] = [];
  provider = new FaceTimeProvider({
    dylibPath: "/nonexistent",
    audioAppPath: "/nonexistent",
    mouthPath: "/nonexistent",
    audioSocketPath: join(dir, "a.sock"),
    mouthSocketPath: join(dir, "m.sock"),
    controlSocketPath: join(dir, "c.sock"),
    mouthDevice: "Feed",
    micDevice: "Mic",
    sampleRate: 24_000,
    callAudioProcesses: ["com.example.call"],
    transcribe: async (pcm) => {
      transcribed.push(pcm.byteLength / 2);
      return { text: "hello there" };
    },
    turnVerdict: async () => 0.9,
    launchFaceTime: () => {},
    launchAudio: () => {},
    launchMouth: () => {},
    ...options,
  });
  await provider.start((event) => events.push(event));
  const socket = join(dir, "a.sock");
  /** A helper connected and its hello taken in (the provider re-checks readiness on hello). */
  const helper = async (hello: Record<string, unknown> = { audio: "pcm16k" }) => {
    const before = events.filter((e) => e.type === "readiness").length;
    const h = await FakeHelper.dial(socket, hello);
    await until(() => events.filter((e) => e.type === "readiness").length > before);
    return h;
  };
  return { events, transcribed, helper };
}

describe("FaceTime hearing", () => {
  test("the call's audio is heard by the ear: speech, its pause, and its words", async () => {
    const { events, helper: connected } = await setUp();
    const helper = await connected();
    await provider!.listen();
    expect(helper.requests).toEqual(["listen"]);
    helper.audio(quiet(200));
    helper.audio(talk(600));
    helper.audio(quiet(500));
    await until(() => events.some((e) => e.type === "heard" && e.final));
    const heard = events.filter((e) => ["speech", "pause", "heard"].includes(e.type));
    expect(heard.map((e) => e.type)).toEqual(expect.arrayContaining(["speech", "pause", "heard"]));
    const final = heard.find((e) => e.type === "heard" && e.final);
    expect(final?.type === "heard" && final.text).toBe("hello there");
    helper.close();
  });

  test("nothing is heard outside a call", async () => {
    const { transcribed, helper: connected } = await setUp();
    const helper = await connected();
    helper.audio(talk(600));
    helper.audio(quiet(500));
    await new Promise((r) => setTimeout(r, 100));
    expect(transcribed).toEqual([]);
    helper.close();
  });

  test("a helper that comes back mid-call is told to listen again; after the call it is not", async () => {
    const { events, helper } = await setUp();
    const first = await helper();
    await provider!.listen();
    first.close();
    const second = await helper();
    await until(() => second.requests.includes("listen"));
    // And it is heard: the ear did not stop with the old helper.
    second.audio(talk(600));
    second.audio(quiet(500));
    await until(() => events.some((e) => e.type === "heard" && e.final));
    await provider!.stopListening();
    second.close();
    const third = await helper();
    await new Promise((r) => setTimeout(r, 100));
    expect(third.requests).toEqual([]);
    third.close();
  });

  test("a helper that streams no audio (an old build) cannot hear calls", async () => {
    const { events, helper } = await setUp();
    const old = await helper({});
    const hearing = await provider!.canHear();
    expect(hearing.ok).toBe(false);
    expect(!hearing.ok && hearing.detail).toContain("does not stream audio");
    const readiness = events.filter((e) => e.type === "readiness");
    expect(readiness.at(-1)).toMatchObject({ ready: false });
    expect(readiness.at(-1)?.type === "readiness" && readiness.at(-1)!.detail).toContain(
      "does not stream audio",
    );
    old.close();
    // The current build is judged on the other helpers instead.
    events.length = 0;
    const current = await helper();
    const detail = events.find((e) => e.type === "readiness");
    expect(detail?.type === "readiness" && detail.detail).not.toContain("does not stream audio");
    current.close();
  });

  test("hearing needs the permission granted to this build, asked again each time", async () => {
    const { helper: connected } = await setUp();
    const helper = await connected();
    expect(await provider!.canHear()).toEqual({ ok: true });
    // A rebuild, or the switch turned off, while the helper runs.
    helper.status = { capture: "undecided" };
    const hearing = await provider!.canHear();
    expect(hearing.ok).toBe(false);
    expect(!hearing.ok && hearing.detail).toContain("permission undecided");
    expect(!hearing.ok && hearing.detail).toContain("System Audio Recording Only");
    // A helper that does not say is not taken as granted.
    helper.status = {};
    expect((await provider!.canHear()).ok).toBe(false);
    helper.close();
  });

  test("with no helper connected, nothing can be heard", async () => {
    await setUp();
    const hearing = await provider!.canHear();
    expect(hearing).toEqual({ ok: false, detail: "the call-audio helper is not running" });
  });

  describe("audio that stops arriving", () => {
    /** The tap's cadence: a 20 ms buffer every 20 ms until stopped. */
    const stream = (helper: FakeHelper) => {
      const timer = setInterval(() => helper.audio(quiet(20)), 20);
      return () => clearInterval(timer);
    };
    const failures = (events: ProviderEvent[]) => events.filter((e) => e.type === "hearing-failed");

    test("mid-call is hearing failed, reported once", async () => {
      const { events, helper: connected } = await setUp({ audioStallMs: 200 });
      const helper = await connected();
      await provider!.listen();
      const stop = stream(helper);
      await new Promise((r) => setTimeout(r, 400));
      expect(failures(events)).toEqual([]);
      // The helper stays connected and says nothing: how the deadlock looked.
      stop();
      await until(() => failures(events).length > 0);
      await new Promise((r) => setTimeout(r, 300));
      expect(failures(events)).toHaveLength(1);
      expect(failures(events)[0]).toMatchObject({
        detail: expect.stringContaining("sent no audio"),
      });
      helper.close();
    });

    test("is not mistaken for a daemon that was busy while the audio kept coming", async () => {
      const { events, helper: connected } = await setUp({ audioStallMs: 200 });
      const helper = await connected();
      await provider!.listen();
      const stop = stream(helper);
      await new Promise((r) => setTimeout(r, 100));
      // Blocks the event loop past the threshold; the stream resumes after.
      const until = Date.now() + 600;
      while (Date.now() < until) {}
      await new Promise((r) => setTimeout(r, 400));
      stop();
      expect(failures(events)).toEqual([]);
      helper.close();
    });

    test("is not watched outside a call", async () => {
      const { events, helper: connected } = await setUp({ audioStallMs: 200 });
      const helper = await connected();
      await new Promise((r) => setTimeout(r, 400));
      await provider!.listen();
      helper.audio(quiet(20));
      await provider!.stopListening();
      await new Promise((r) => setTimeout(r, 600));
      expect(failures(events)).toEqual([]);
      helper.close();
    });
  });

  test("a tap that cannot be built during a call is reported as hearing failed", async () => {
    const { events, helper: connected } = await setUp();
    const helper = await connected();
    helper.send({ event: "listening", processes: [], error: "before the call" });
    await new Promise((r) => setTimeout(r, 50));
    await provider!.listen();
    helper.send({ event: "listening", processes: [], error: "AudioDeviceStart failed (-1)" });
    await until(() => events.some((e) => e.type === "hearing-failed"));
    expect(events.filter((e) => e.type === "hearing-failed")).toEqual([
      { type: "hearing-failed", detail: "call tap: AudioDeviceStart failed (-1)" },
    ]);
    helper.close();
  });
});
