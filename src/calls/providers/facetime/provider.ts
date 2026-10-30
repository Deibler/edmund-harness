/**
 * FaceTime, as a CallProvider: the three native helpers behind one interface.
 *
 *   FaceTimeControl.dylib  injected into FaceTime.app; calls (TelephonyUtilities)
 *   EdmundCallAudio.app    hearing: the muted tap + recognition, and the speaker guard
 *   EdmundMouth            Edmund's voice, into the virtual microphone
 *
 * This file launches and supervises them and translates their messages. It
 * decides nothing about calls; the CallManager does.
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../../../util/log.ts";
import type { CallProvider, CallState, Peer, ProviderCall, ProviderEvent } from "../../types.ts";
import { JsonLinesServer, type JsonMessage } from "./json-lines.ts";
import { type RouteReport, type RouteVerdict, judgeRoute, parseRoute } from "./route.ts";

const FACETIME_BINARY = "/System/Applications/FaceTime.app/Contents/MacOS/FaceTime";

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
  locale: string;
  /** Test seams: how the helpers are started. */
  launchFaceTime?: () => void;
  launchAudio?: () => void;
  launchMouth?: () => void;
  /** How long a helper may stay disconnected before it is relaunched. */
  reconnectGraceMs?: number;
  /** How long after connecting FaceTime may take to open the microphone. */
  routeTimeoutMs?: number;
  /** Scores each pause: has the caller finished their turn? Absent, none are scored. */
  turnDetector?: {
    verdict(pcmBase64: string): Promise<{ probability: number; ms: number } | null>;
  };
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

export class FaceTimeProvider implements CallProvider {
  readonly name = "FaceTime";
  private readonly options: FaceTimeOptions;
  private readonly control: JsonLinesServer;
  private readonly audio: JsonLinesServer;
  private readonly mouth: JsonLinesServer;
  private onEvent: (event: ProviderEvent) => void = () => {};
  private supervisor: ReturnType<typeof setInterval> | null = null;
  private disconnectedSince = { control: 0, audio: 0, mouth: 0 };

  constructor(options: FaceTimeOptions) {
    this.options = options;
    this.control = new JsonLinesServer(controlSocketPath(), "FaceTime control", (m) =>
      this.onControl(m),
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

  async listen(): Promise<void> {
    await this.audio.request(
      "listen",
      { bundleIds: this.options.callAudioProcesses, locale: this.options.locale },
      30_000,
    );
  }

  async stopListening(): Promise<void> {
    await this.audio.request("stopListening", {}, 15_000);
  }

  async finalizeHearing(audioMs: number): Promise<void> {
    await this.audio.request("finalize", { throughMs: Math.round(audioMs) }, 2_000);
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
    const now = Date.now();
    switch (message.event) {
      case "hello":
        log.info("facetime", "call audio connected", { guard: JSON.stringify(message.guard) });
        void this.readiness();
        return;
      case "transcript": {
        const origin = typeof message.originMs === "number" ? message.originMs : null;
        this.onEvent({
          type: "heard",
          text: String(message.text ?? ""),
          final: message.final === true,
          atMs: now,
          ...(origin !== null && typeof message.endMs === "number"
            ? { spokeUntilMs: origin + message.endMs }
            : {}),
        });
        return;
      }
      case "pause":
        void this.onPause(message, now);
        return;
      case "speech":
        this.onEvent({ type: "speech", talking: message.detected === true, atMs: now });
        return;
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
        return;
      case "error":
        log.warn("facetime", "call audio error", {
          where: message.where,
          message: message.message,
        });
        return;
    }
  }

  /**
   * The listener heard the caller pause. Smart Turn scores the last 8 s of
   * their speech (~12 ms, plus the round trip) before the manager hears of
   * the pause, so it can end the turn at once or keep listening.
   */
  private async onPause(message: JsonMessage, arrivedMs: number): Promise<void> {
    const audioMs = Number(message.stopMs);
    if (!Number.isFinite(audioMs)) return;
    const origin = typeof message.originMs === "number" ? message.originMs : null;
    const pcm = typeof message.pcm === "string" ? message.pcm : "";
    const verdict =
      pcm && this.options.turnDetector ? await this.options.turnDetector.verdict(pcm) : null;
    this.onEvent({
      type: "pause",
      stoppedAtMs: origin !== null ? origin + audioMs : arrivedMs,
      audioMs,
      probability: verdict?.probability ?? null,
    });
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
