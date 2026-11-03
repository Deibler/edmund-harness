/**
 * FaceTime, as a CallProvider: the three native helpers behind one interface.
 *
 *   FaceTimeControl.dylib  injected into FaceTime.app; calls (TelephonyUtilities)
 *   EdmundCallAudio.app    the muted tap on the call's audio, and the speaker guard
 *   EdmundMouth            Edmund's voice, into the virtual microphone
 *
 * The tap's audio is heard here, by the same Ear the voice lab uses
 * (calls/ear.ts), so a call hears exactly as the lab does.
 *
 * This file launches and supervises them and translates their messages. It
 * decides nothing about calls; the CallManager does.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../../util/log.ts";
import { Ear, type EarDeps } from "../../ear.ts";
import type { CallProvider, CallState, Peer, ProviderCall, ProviderEvent } from "../../types.ts";
import { JsonLinesServer, type JsonMessage } from "./json-lines.ts";
import { type RouteReport, type RouteVerdict, judgeRoute, parseRoute } from "./route.ts";

const FACETIME_BINARY = "/System/Applications/FaceTime.app/Contents/MacOS/FaceTime";

/** What the call-audio helper says it streams; an older build streams nothing. */
const AUDIO_FORMAT = "pcm16k";

/**
 * The helper sends every buffer the tap converts, silence included: 11-21 ms
 * apart across 24 probe cycles (2026-10-30). Audio missing for this long means
 * the tap stopped, however it stopped. A helper that deadlocked stayed
 * connected and sent nothing, so being connected says nothing about hearing.
 */
const AUDIO_STALL_MS = 2_000;

/**
 * Where the operator gives the helper its permission. Switching an existing
 * entry back on is not enough after a rebuild: the entry names the old build.
 */
const CAPTURE_GRANT =
  "System Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only: remove EdmundCallAudio, then add native/facetime/build/EdmundCallAudio.app";

/**
 * FaceTime is sandboxed: the injected code can only reach a socket inside its
 * own container (the same rule imcore-bridge found for Messages).
 */
export function controlSocketPath(): string {
  return join(
    homedir(),
    "Library",
    "Containers",
    "com.apple.FaceTime",
    "Data",
    "tmp",
    "edmund-facetime.sock",
  );
}

export type FaceTimeOptions = {
  dylibPath: string;
  audioAppPath: string;
  audioSocketPath: string;
  mouthPath: string;
  mouthSocketPath: string;
  /** Where Edmund's voice plays (the driver's play-only Feed). */
  mouthDevice: string;
  /** The record-only device FaceTime must listen on; it hears mouthDevice. */
  micDevice: string;
  /** Rate every speech chunk is synthesised at; the mouth is opened at it. */
  sampleRate: number;
  callAudioProcesses: string[];
  transcribe: EarDeps["transcribe"];
  turnVerdict: EarDeps["turnVerdict"];
  /** Test seams: how the helpers are started, and where FaceTime's dylib dials. */
  controlSocketPath?: string;
  launchFaceTime?: () => void;
  launchAudio?: () => void;
  launchMouth?: () => void;
  /** How long a helper may stay disconnected before it is relaunched. */
  reconnectGraceMs?: number;
  /** How long after connecting FaceTime may take to open the microphone. */
  routeTimeoutMs?: number;
  /** How long a call's audio may stop arriving before the call counts as unheard. */
  audioStallMs?: number;
  /** When set, the last 30 scored clips are kept here as WAV with their scores (diagnosis only). */
  turnClipDir?: string;
};

/**
 * TUCallStatus, as the dylib reports it, from public reverse engineering of
 * TelephonyUtilities. 4 ringing, 1 active and 6 ended were seen on live 26.4
 * calls (2026-10-29); the rest are not yet confirmed, so every call event
 * still logs its raw status (onControl). An unknown status is ignored, never
 * guessed.
 */
const STATES: Record<number, CallState> = {
  1: "active",
  2: "active", // held still has the call up
  3: "dialing",
  4: "ringing",
  5: "ending",
  6: "ended",
};

/** A call as the dylib describes it, or null for one that is not a FaceTime call. */
export function toProviderCall(raw: JsonMessage): ProviderCall | null {
  if (raw.faceTime !== true || typeof raw.id !== "string") return null;
  const state = STATES[Number(raw.status)];
  if (!state) return null;
  const handles = Array.isArray(raw.remoteHandles) ? raw.remoteHandles.map(String) : [];
  const group = typeof raw.messagesGroupUUID === "string" ? raw.messagesGroupUUID : null;
  const handle = typeof raw.handle === "string" && raw.handle ? raw.handle : (handles[0] ?? null);
  const peer: Peer | null = group
    ? { kind: "group", messagesGroupId: group, handles }
    : handle
      ? { kind: "person", handle }
      : null;
  return {
    id: raw.id,
    direction: raw.incoming === true ? "incoming" : "outgoing",
    state,
    peer,
    raw: { status: raw.status, state: raw.state, disconnectedReason: raw.disconnectedReason },
  };
}

/** A scored clip as a 16 kHz mono WAV named for its time and score; the oldest beyond 30 go. */
function keepTurnClip(dir: string, pcmBase64: string, probability: number | null): void {
  try {
    mkdirSync(dir, { recursive: true });
    const pcm = Buffer.from(pcmBase64, "base64");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);
    const score = probability === null ? "none" : probability.toFixed(3);
    writeFileSync(join(dir, `${Date.now()}-p${score}.wav`), Buffer.concat([header, pcm]));
    const clips = readdirSync(dir)
      .filter((f) => f.endsWith(".wav"))
      .sort();
    for (const old of clips.slice(0, Math.max(0, clips.length - 30))) {
      rmSync(join(dir, old), { force: true });
    }
  } catch (err) {
    log.warn("facetime", "could not keep turn clip", { err: (err as Error).message });
  }
}

export class FaceTimeProvider implements CallProvider {
  readonly name = "FaceTime";
  private readonly options: FaceTimeOptions;
  private readonly control: JsonLinesServer;
  private readonly audio: JsonLinesServer;
  private readonly mouth: JsonLinesServer;
  private onEvent: (event: ProviderEvent) => void = () => {};
  private supervisor: ReturnType<typeof setInterval> | null = null;
  private disconnectedSince = { control: 0, audio: 0, mouth: 0 };
  private readonly ear: Ear;
  /** Between listen() and stopListening(): a helper that reconnects is told again. */
  private listening = false;
  /** Whether the connected call-audio helper streams the call's audio. */
  private streamsAudio = false;
  /** When the tap's audio last arrived, and the check that it keeps arriving. */
  private lastAudioAt = 0;
  private stallCheck: ReturnType<typeof setInterval> | null = null;

  constructor(options: FaceTimeOptions) {
    this.options = options;
    const clipDir = options.turnClipDir;
    this.ear = new Ear({
      transcribe: options.transcribe,
      turnVerdict: options.turnVerdict,
      emit: (event) => this.onEvent(event),
      ...(clipDir
        ? { onTurnClip: (pcm, probability) => keepTurnClip(clipDir, pcm, probability) }
        : {}),
    });
    this.control = new JsonLinesServer(
      options.controlSocketPath ?? controlSocketPath(),
      "FaceTime control",
      (m) => this.onControl(m),
    );
    this.audio = new JsonLinesServer(options.audioSocketPath, "call audio", (m) => this.onAudio(m));
    this.mouth = new JsonLinesServer(options.mouthSocketPath, "voice", (m) => this.onMouth(m));
  }

  async start(onEvent: (event: ProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    await this.control.listen();
    await this.audio.listen();
    await this.mouth.listen();
    // A FaceTime or helper left running by the previous daemon redials on its
    // own; only relaunch what has not come back after the grace period.
    const now = Date.now();
    this.disconnectedSince = { control: now, audio: now, mouth: now };
    this.supervisor = setInterval(() => this.supervise(), 2_000);
  }

  async stop(): Promise<void> {
    if (this.supervisor) clearInterval(this.supervisor);
    this.supervisor = null;
    this.unwatchAudio();
    this.control.close();
    this.audio.close();
    this.mouth.close();
  }

  async dial(handle: string): Promise<ProviderCall> {
    const raw = (await this.control.request("dial", { handle, video: false })) as JsonMessage;
    const call = toProviderCall(raw);
    if (!call)
      throw new Error(`FaceTime reported a call it could not describe: ${JSON.stringify(raw)}`);
    return call;
  }

  async answer(callId: string): Promise<void> {
    await this.control.request("answer", { id: callId });
  }

  async hangup(callId: string): Promise<void> {
    await this.control.request("hangup", { id: callId });
  }

  /**
   * Asked of the helper each time rather than remembered from its hello: the
   * permission can be switched off while it runs, and every rebuild loses it.
   */
  async canHear(): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (!this.audio.connected()) {
      return { ok: false, detail: "the call-audio helper is not running" };
    }
    if (!this.streamsAudio) {
      return {
        ok: false,
        detail:
          "the call-audio helper is an old build that does not stream audio (make -C native/facetime audio)",
      };
    }
    const status = (await this.audio.request("status", {}, 5_000)) as JsonMessage;
    if (status.capture !== "granted") {
      return {
        ok: false,
        detail: `macOS does not let the call-audio helper hear calls (permission ${String(status.capture ?? "not reported")}); ${CAPTURE_GRANT}`,
      };
    }
    return { ok: true };
  }

  async listen(): Promise<void> {
    this.listening = true;
    this.ear.begin();
    this.watchAudio();
    await this.tap();
  }

  async stopListening(): Promise<void> {
    this.listening = false;
    this.unwatchAudio();
    this.ear.end();
    await this.audio.request("stopListening", {}, 15_000);
  }

  /**
   * A call whose audio stops arriving is a call Edmund cannot hear. Stale on
   * two checks in a row before it counts: audio queued behind a daemon that
   * was busy for a moment is read between them.
   */
  private watchAudio(): void {
    this.unwatchAudio();
    const stallMs = this.options.audioStallMs ?? AUDIO_STALL_MS;
    this.lastAudioAt = Date.now();
    let stale = false;
    this.stallCheck = setInterval(() => {
      const silentMs = Date.now() - this.lastAudioAt;
      if (silentMs < stallMs) {
        stale = false;
        return;
      }
      if (!stale) {
        stale = true;
        return;
      }
      this.unwatchAudio();
      this.onEvent({
        type: "hearing-failed",
        detail: `the call-audio helper sent no audio for ${(silentMs / 1000).toFixed(1)}s`,
      });
    }, stallMs / 4);
    this.stallCheck.unref?.();
  }

  private unwatchAudio(): void {
    if (this.stallCheck) clearInterval(this.stallCheck);
    this.stallCheck = null;
  }

  private async tap(): Promise<void> {
    await this.audio.request("listen", { bundleIds: this.options.callAudioProcesses }, 30_000);
  }

  /**
   * Polls the call's per-process route until FaceTime is listening on
   * Edmund's microphone and playing to a real speaker. Measured 2026-10-29:
   * the microphone opened 2.4 s after the call reported active. Each change
   * of verdict is logged with the full report, so a refused route can be read
   * back from the daemon log.
   */
  async audioReady(): Promise<RouteVerdict> {
    const deadline = Date.now() + (this.options.routeTimeoutMs ?? 15_000);
    let last = "";
    for (;;) {
      let verdict: RouteVerdict;
      let report: RouteReport | null = null;
      try {
        report = parseRoute(
          await this.mouth.request("route", { bundleIds: this.options.callAudioProcesses }),
        );
        verdict = judgeRoute(report, this.options.micDevice);
      } catch (err) {
        verdict = { ok: false, detail: `route unreadable: ${(err as Error).message}` };
      }
      const detail = verdict.ok ? "ready" : verdict.detail;
      if (detail !== last) {
        log.info("facetime", "call audio route", { detail, report: JSON.stringify(report) });
        last = detail;
      }
      if (verdict.ok || Date.now() >= deadline) return verdict;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async say(chunkId: string, pcm: Uint8Array, sampleRate: number): Promise<void> {
    if (sampleRate !== this.options.sampleRate) {
      throw new Error(
        `speech at ${sampleRate} Hz, but the mouth plays ${this.options.sampleRate} Hz`,
      );
    }
    await this.mouth.request("say", { id: chunkId, pcm: Buffer.from(pcm).toString("base64") });
  }

  async flush(): Promise<void> {
    await this.mouth.request("flush");
  }

  // ── Messages from the helpers ─────────────────────────────────────────

  private onControl(message: JsonMessage): void {
    if (message.event === "hello") {
      log.info("facetime", "FaceTime control connected", { pid: message.pid });
      void this.readiness();
      return;
    }
    if (message.event === "call" && message.call && typeof message.call === "object") {
      const raw = message.call as JsonMessage;
      const call = toProviderCall(raw);
      // Raw status is logged on every change until the mapping has been seen
      // against real calls; a wrong guess here would misread a call's state.
      log.info("facetime", "call event", {
        status: raw.status,
        state: raw.state,
        incoming: raw.incoming,
        mapped: call?.state ?? "ignored",
      });
      if (call) this.onEvent({ type: "call", call });
    }
  }

  private onAudio(message: JsonMessage): void {
    switch (message.event) {
      case "hello":
        this.streamsAudio = message.audio === AUDIO_FORMAT;
        log.info("facetime", "call audio connected", {
          audio: message.audio ?? "none",
          capture: message.capture ?? "not reported",
          guard: JSON.stringify(message.guard),
        });
        // A helper relaunched mid-call starts deaf; the call still wants it.
        if (this.listening && this.streamsAudio) {
          void this.tap().catch((err) =>
            log.warn("facetime", "could not re-open the call tap", {
              err: (err as Error).message,
            }),
          );
        }
        void this.readiness();
        return;
      case "audio": {
        if (typeof message.pcm !== "string") return;
        this.lastAudioAt = Date.now();
        const bytes = Buffer.from(message.pcm, "base64");
        const samples = new Int16Array(bytes.byteLength >> 1);
        new Uint8Array(samples.buffer).set(bytes.subarray(0, samples.byteLength));
        this.ear.feed(samples);
        return;
      }
      case "guard":
        this.onEvent({
          type: "silence-breach",
          device: String(message.device ?? "an output"),
          detail: String(message.reason ?? "was audible"),
        });
        return;
      case "listening":
        log.info("facetime", "call audio tap", {
          processes: message.processes,
          error: message.error,
        });
        // The tap could not be built: nothing the caller says reaches the ear.
        if (this.listening && typeof message.error === "string") {
          this.onEvent({ type: "hearing-failed", detail: `call tap: ${message.error}` });
        }
        return;
    }
  }

  private onMouth(message: JsonMessage): void {
    if (message.event === "hello") {
      log.info("facetime", "voice connected", {
        device: message.device,
        current_device: message.currentDevice,
        error: message.error,
      });
      void this.readiness();
      return;
    }
    if (message.event === "spoken") {
      // Where each chunk really went and how loud it was halfway through:
      // the first live call reported "played" for speech sent to a muted
      // speaker, so the claim is logged beside the evidence.
      log.info("facetime", "voice chunk done", {
        played: message.played,
        mid_level_db: message.midLevelDb,
        current_device: message.currentDevice,
        running: message.running,
      });
      this.onEvent({
        type: "spoken",
        chunkId: String(message.id),
        played: message.played === true,
      });
    }
  }

  /**
   * FaceTime loads its providers a moment after launch, so a check right at
   * hello reads "no provider" on a Mac that is signed in. Measured
   * 2026-10-29: absent at +1 s, present at +10 s. Checked again before
   * reporting not-ready.
   */
  private async readiness(attempt = 0): Promise<void> {
    if (attempt === 0) {
      for (let retry = 1; retry <= 3; retry++) {
        setTimeout(() => void this.readiness(retry), retry * 3_000).unref?.();
      }
    }
    const up = (server: JsonLinesServer) => (server.connected() ? "up" : "down");
    if (this.audio.connected()) {
      // Reported here so the log says why; calls are refused by canHear().
      const hearing = await this.canHear().catch((err: unknown) => ({
        ok: false as const,
        detail: (err as Error).message,
      }));
      if (!hearing.ok) {
        this.onEvent({ type: "readiness", ready: false, detail: hearing.detail });
        return;
      }
    }
    if (!this.control.connected() || !this.audio.connected() || !this.mouth.connected()) {
      this.onEvent({
        type: "readiness",
        ready: false,
        detail: `control ${up(this.control)}, hearing ${up(this.audio)}, voice ${up(this.mouth)}`,
      });
      return;
    }
    try {
      const voice = (await this.mouth.request("status")) as JsonMessage;
      const control = (await this.control.request("status")) as JsonMessage;
      const mouth = typeof voice.device === "string";
      // The dylib boxes this as a number (1/0), not a JSON boolean.
      const signedIn = Boolean(control.faceTimeProvider);
      this.onEvent({
        type: "readiness",
        ready: mouth && signedIn,
        detail: [
          // `currentDevice` is null between bursts: no stream is open then.
          mouth ? `voice on ${voice.device}` : `no voice (${voice.error})`,
          signedIn ? "FaceTime signed in" : "FaceTime has no provider (signed out?)",
        ].join(", "),
      });
    } catch (err) {
      this.onEvent({ type: "readiness", ready: false, detail: (err as Error).message });
    }
  }

  // ── Supervision ───────────────────────────────────────────────────────

  private supervise(): void {
    const grace = this.options.reconnectGraceMs ?? 8_000;
    const now = Date.now();
    for (const which of ["control", "audio", "mouth"] as const) {
      const server =
        which === "control" ? this.control : which === "audio" ? this.audio : this.mouth;
      if (server.connected()) {
        this.disconnectedSince[which] = 0;
        continue;
      }
      if (this.disconnectedSince[which] === 0) {
        this.disconnectedSince[which] = now;
        continue;
      }
      if (now - this.disconnectedSince[which] < grace) continue;
      this.disconnectedSince[which] = now;
      log.warn("facetime", `${which} helper not connected; launching it`);
      if (which === "control") (this.options.launchFaceTime ?? (() => this.launchFaceTime()))();
      else if (which === "audio") (this.options.launchAudio ?? (() => this.launchAudio()))();
      else (this.options.launchMouth ?? (() => this.launchMouth()))();
    }
  }

  /**
   * FaceTime with the dylib injected. It is exec'd directly: `open` strips
   * DYLD_* from the environment. A FaceTime already running without the dylib
   * is quit first, or the launch would only focus it.
   */
  private launchFaceTime(): void {
    spawnSync("osascript", ["-e", 'tell application "FaceTime" to quit'], {
      stdio: "ignore",
      timeout: 10_000,
    });
    const child = spawn(FACETIME_BINARY, [], {
      env: {
        ...process.env,
        DYLD_INSERT_LIBRARIES: this.options.dylibPath,
        EDMUND_FACETIME_SOCKET: controlSocketPath(),
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  /**
   * Through LaunchServices, so macOS attributes the audio-capture permission
   * to the helper app rather than to the daemon that started it.
   */
  private launchAudio(): void {
    spawnSync("pkill", ["-f", "EdmundCallAudio.app/Contents/MacOS/EdmundCallAudio"], {
      stdio: "ignore",
    });
    spawn(
      "open",
      [
        "-g",
        "-n",
        "-a",
        this.options.audioAppPath,
        "--args",
        "--socket",
        this.options.audioSocketPath,
      ],
      { stdio: "ignore", detached: true },
    ).unref();
  }

  /** A plain child: playing audio needs no permission to attribute. */
  private launchMouth(): void {
    spawnSync("pkill", ["-f", this.options.mouthPath], { stdio: "ignore" });
    spawn(
      this.options.mouthPath,
      [
        "--socket",
        this.options.mouthSocketPath,
        "--device",
        this.options.mouthDevice,
        "--rate",
        String(this.options.sampleRate),
      ],
      { stdio: "ignore", detached: true },
    ).unref();
  }
}
