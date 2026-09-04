import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../../src/config/config.ts";
import { mirrorConfig } from "../config.ts";

/**
 * Warm local speech — Kokoro synthesis and Whisper recognition — as one
 * supervised Python sidecar.
 *
 * Measured on this Mac (M4, ONNX fp32, CPU provider) against the OpenRouter
 * path it replaces: 0.36s vs 1.40s for a one-liner, 1.44s vs 3.93s for a
 * typical multi-clause reply — and without OpenRouter's ±2s jitter, which was
 * the more visible problem in conversation. int8 measured 2x SLOWER than fp32
 * (ARM dequantization overhead) and CoreML fragmented the graph into 109
 * partitions for no gain, so fp32-on-CPU is deliberate, not a default.
 *
 * The sidecar owns a ~325 MB graph and takes ~0.4s to load, so it is started
 * once and kept resident. Everything here is failure-tolerant by construction:
 * every path that cannot produce audio promptly returns null, and the caller
 * falls back to OpenRouter. A dead sidecar degrades the mirror's latency, never
 * its ability to speak.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const BOOT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Restart cadence for the reference pipeline's known CPU memory growth. */
const RESTART_AFTER_REQUESTS = 500;
/** Consecutive spawn failures before the sidecar is written off for the run. */
const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Crashes *after* a successful boot before giving up. Without this, a sidecar
 * that boots cleanly and then dies on every request would respawn forever —
 * each turn silently paying a spawn on top of the OpenRouter fallback it ends
 * up using anyway.
 */
const MAX_POST_BOOT_CRASHES = 5;

type PendingRequest = {
  resolve: (value: KokoroAudio | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingText = {
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type KokoroAudio = {
  /** Raw 24 kHz mono PCM16 — the same shape OpenRouter's `pcm` format returns. */
  pcm: Uint8Array;
  sampleRate: number;
  /** Sidecar-side synthesis time, for logging. */
  synthesisMs: number;
};

export class SpeechSidecar {
  private readonly pythonBin: string;
  private readonly scriptPath: string;
  private readonly modelPath: string;
  private readonly voicesPath: string;
  private readonly defaultVoice: string;
  private readonly sttModel: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private booting: Promise<boolean> | null = null;
  private ready = false;
  private stopped = false;
  private stdoutBuffer = "";
  private pending = new Map<string, PendingRequest>();
  private pendingText = new Map<string, PendingText>();
  private sequence = 0;
  private servedSinceSpawn = 0;
  private consecutiveFailures = 0;
  private postBootCrashes = 0;

  constructor(config: Config) {
    const mirror = mirrorConfig(config);
    this.pythonBin = expandHome(mirror.kokoro_python || defaultPython());
    this.modelPath = expandHome(mirror.kokoro_model || defaultModel());
    this.voicesPath = expandHome(mirror.kokoro_voices || defaultVoices());
    this.defaultVoice = mirror.kokoro_voice;
    this.sttModel = mirror.local_stt_model;
    this.scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "speech-sidecar.py");
  }

  /** True when the sidecar's dependencies are present on this machine. */
  installed(): boolean {
    return (
      existsSync(this.pythonBin) &&
      existsSync(this.scriptPath) &&
      existsSync(this.modelPath) &&
      existsSync(this.voicesPath)
    );
  }

  /** Absent files are a misconfiguration worth naming precisely at boot. */
  missingPaths(): string[] {
    return (
      [
        ["python", this.pythonBin],
        ["script", this.scriptPath],
        ["model", this.modelPath],
        ["voices", this.voicesPath],
      ] as const
    )
      .filter(([, path]) => !existsSync(path))
      .map(([label, path]) => `${label}=${path}`);
  }

  /**
   * Boot the sidecar ahead of the first utterance.
   *
   * Spawning is otherwise lazy, so the first person to speak after a restart
   * pays the ONNX graph load, the throwaway warm-up synthesis and the Whisper
   * load — a few seconds of silence at exactly the moment the mirror is
   * supposed to feel instant. Doing it at daemon boot moves that cost to a
   * time when nobody is waiting.
   *
   * Fire-and-forget and never throws: a sidecar that cannot boot is a fallback
   * to hosted speech, which ensureRunning() already reports.
   */
  async warmup(): Promise<void> {
    if (this.stopped || !this.installed()) return;
    await this.ensureRunning().catch(() => false);
  }

  /**
   * Synthesize, or return null so the caller can fall back. Never throws:
   * losing local TTS is a latency regression, not a failed turn.
   */
  async synthesize(text: string, voice?: string): Promise<KokoroAudio | null> {
    if (this.stopped) return null;
    const clean = text.trim();
    if (!clean) return null;
    if (!(await this.ensureRunning())) return null;

    const proc = this.proc;
    if (!proc?.stdin.writable) return null;

    if (this.servedSinceSpawn >= RESTART_AFTER_REQUESTS) {
      console.log("[mirror] kokoro recycling sidecar after 500 requests");
      this.restart("request budget reached");
      if (!(await this.ensureRunning())) return null;
    }

    const id = `r${++this.sequence}`;
    const request = JSON.stringify({
      id,
      text: clean,
      voice: voice || this.defaultVoice,
    });

    return new Promise<KokoroAudio | null>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        console.warn(`[mirror] kokoro timed out after ${REQUEST_TIMEOUT_MS}ms`);
        // A timeout means the sidecar is wedged or pathologically slow; its
        // late reply would desynchronize this stream from every later request.
        this.restart("request timed out");
        resolvePromise(null);
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, timer });
      this.servedSinceSpawn += 1;
      try {
        this.proc?.stdin.write(`${request}\n`);
      } catch (err) {
        this.settle(id, null);
        console.warn(`[mirror] kokoro write failed: ${safeError(err)}`);
      }
    });
  }

  /**
   * Recognize an utterance locally, or return null so the caller falls back.
   *
   * Measured on this Mac against six mirror-style phrases: 0.25s and a 0% word
   * error rate with base.en, versus roughly a second for the hosted round trip.
   * Like synthesis, it never throws — losing local STT costs latency, not a turn.
   */
  async transcribe(wavBase64: string): Promise<string | null> {
    // A blank model is an explicit opt-out: keep local synthesis, use the
    // hosted recognizer.
    if (this.stopped || !wavBase64 || !this.sttModel) return null;
    if (!(await this.ensureRunning())) return null;
    if (!this.proc?.stdin.writable) return null;

    const id = `s${++this.sequence}`;
    return new Promise<string | null>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.pendingText.delete(id);
        console.warn(`[mirror] local stt timed out after ${REQUEST_TIMEOUT_MS}ms`);
        this.restart("stt request timed out");
        resolvePromise(null);
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pendingText.set(id, { resolve: resolvePromise, timer });
      try {
        this.proc?.stdin.write(`${JSON.stringify({ id, stt: true, wav: wavBase64 })}\n`);
      } catch (err) {
        this.settleText(id, null);
        console.warn(`[mirror] local stt write failed: ${safeError(err)}`);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.teardown("shutting down");
  }

  private async ensureRunning(): Promise<boolean> {
    if (this.ready && this.proc) return true;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;
    if (this.booting) return this.booting;
    this.booting = this.spawnSidecar().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  private spawnSidecar(): Promise<boolean> {
    if (!this.installed()) {
      console.warn(`[mirror] kokoro unavailable (missing ${this.missingPaths().join(", ")})`);
      this.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolveBoot) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(this.pythonBin, [this.scriptPath], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            KOKORO_MODEL: this.modelPath,
            KOKORO_VOICES: this.voicesPath,
            KOKORO_VOICE: this.defaultVoice,
            WHISPER_MODEL: this.sttModel,
            // The phonemizer resolves espeak-ng through its bundled loader;
            // an inherited override from the parent shell only breaks it.
            PHONEMIZER_ESPEAK_LIBRARY: "",
          },
        });
      } catch (err) {
        this.consecutiveFailures += 1;
        console.error(`[mirror] kokoro spawn failed: ${safeError(err)}`);
        resolveBoot(false);
        return;
      }

      this.proc = proc;
      this.ready = false;
      this.stdoutBuffer = "";
      this.servedSinceSpawn = 0;

      let settled = false;
      const settleBoot = (ok: boolean, reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(bootTimer);
        if (ok) {
          this.ready = true;
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures += 1;
          if (reason) console.error(`[mirror] kokoro boot failed: ${reason}`);
          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error("[mirror] kokoro disabled for this run; using OpenRouter TTS");
          }
        }
        resolveBoot(ok);
      };

      const bootTimer = setTimeout(() => {
        settleBoot(false, `did not become ready within ${BOOT_TIMEOUT_MS}ms`);
        this.teardown("boot timed out");
      }, BOOT_TIMEOUT_MS);
      bootTimer.unref?.();

      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        this.stdoutBuffer += chunk;
        if (this.stdoutBuffer.length > MAX_RESPONSE_BYTES) {
          this.stdoutBuffer = "";
          console.warn("[mirror] kokoro response exceeded bounds; restarting");
          this.restart("oversized response");
          return;
        }
        const lines = this.stdoutBuffer.split("\n");
        this.stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) this.handleLine(line, settleBoot);
        }
      });

      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          // onnxruntime and phonemizer are chatty on stderr; surface only the
          // sidecar's own lines and anything that reads like a real failure.
          if (!trimmed) continue;
          if (trimmed.startsWith("[kokoro]")) console.log(`[mirror] ${trimmed}`);
          else if (/error|traceback|exception/i.test(trimmed)) {
            console.warn(`[mirror] kokoro: ${trimmed.slice(0, 240)}`);
          }
        }
      });

      proc.on("error", (err) => {
        settleBoot(false, safeError(err));
        this.failAllPending("kokoro process error");
      });

      proc.on("exit", (code, signal) => {
        // A deliberate teardown (recycle, timeout, shutdown) already cleared
        // this.proc; only an unexpected death still owns the slot.
        const crashed = this.proc === proc && this.ready;
        this.ready = false;
        if (this.proc === proc) this.proc = null;
        this.failAllPending("kokoro process exited");
        settleBoot(false, `exited with code=${code} signal=${signal}`);
        if (!crashed || this.stopped) return;
        this.postBootCrashes += 1;
        if (this.postBootCrashes >= MAX_POST_BOOT_CRASHES) {
          this.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
          console.error(
            `[mirror] kokoro crashed ${this.postBootCrashes}x after booting; disabled for this run, using OpenRouter TTS`,
          );
          return;
        }
        console.warn(`[mirror] kokoro exited (code=${code}); next request respawns it`);
      });
    });
  }

  private handleLine(line: string, settleBoot: (ok: boolean, reason?: string) => void): void {
    let message: {
      id?: unknown;
      ok?: unknown;
      ready?: unknown;
      error?: unknown;
      pcm16?: unknown;
      rate?: unknown;
      ms?: unknown;
      text?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      console.warn(`[mirror] kokoro emitted a non-protocol line: ${line.slice(0, 160)}`);
      return;
    }

    if (message.id === "boot") {
      if (message.ok === true && message.ready === true) settleBoot(true);
      else settleBoot(false, String(message.error ?? "unknown boot failure"));
      return;
    }

    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return;

    if (this.pendingText.has(id)) {
      if (message.ok !== true || typeof message.text !== "string") {
        console.warn(`[mirror] local stt failed: ${String(message.error ?? "unknown")}`);
        this.settleText(id, null);
        return;
      }
      this.postBootCrashes = 0;
      this.settleText(id, message.text.trim());
      return;
    }

    if (!this.pending.has(id)) return;

    if (message.ok !== true || typeof message.pcm16 !== "string") {
      console.warn(`[mirror] kokoro synthesis failed: ${String(message.error ?? "unknown")}`);
      this.settle(id, null);
      return;
    }

    const pcm = Buffer.from(message.pcm16, "base64");
    const sampleRate = typeof message.rate === "number" ? message.rate : 24_000;
    if (pcm.length === 0) {
      this.settle(id, null);
      return;
    }
    // Real audio is the only proof the sidecar is healthy, so the crash budget
    // counts consecutive failures — an occasional hiccup over a long-lived
    // daemon must not accumulate its way to disabled.
    this.postBootCrashes = 0;
    this.settle(id, {
      pcm: new Uint8Array(pcm),
      sampleRate,
      synthesisMs: typeof message.ms === "number" ? message.ms : 0,
    });
  }

  private settle(id: string, value: KokoroAudio | null): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(value);
  }

  private settleText(id: string, value: string | null): void {
    const pending = this.pendingText.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingText.delete(id);
    pending.resolve(value);
  }

  private failAllPending(reason: string): void {
    if (this.pending.size + this.pendingText.size > 0) {
      console.warn(`[mirror] speech sidecar: ${reason}`);
    }
    for (const id of [...this.pending.keys()]) this.settle(id, null);
    for (const id of [...this.pendingText.keys()]) this.settleText(id, null);
  }

  private restart(reason: string): void {
    this.teardown(reason);
    // ensureRunning() respawns lazily on the next request rather than eagerly
    // here, so a restart storm cannot outpace the failure counter.
  }

  private teardown(reason: string): void {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.stdoutBuffer = "";
    this.failAllPending(reason);
    if (!proc) return;
    try {
      proc.stdin.end();
      proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

function defaultPython(): string {
  return join(homedir(), ".local", "share", "edmund-harness", "kokoro-venv", "bin", "python3");
}

function defaultModel(): string {
  return join(homedir(), ".local", "share", "edmund-harness", "kokoro-models", "kokoro-v1.0.onnx");
}

function defaultVoices(): string {
  return join(homedir(), ".local", "share", "edmund-harness", "kokoro-models", "voices-v1.0.bin");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
