/**
 * What did the caller say? The client for transcriber.py, which runs Parakeet
 * on one finished stretch of a caller's speech at a time.
 *
 * Every request stands alone: there is no recognition session to keep alive,
 * so a crash costs the requests in flight and nothing after them. The answer
 * keeps "heard nothing" ("") apart from "could not tell" (null), because the
 * first is a cough and the second is a person who must be asked again.
 *
 * Started with the call runtime and kept resident (~0.9 GB): a model loaded
 * when someone starts talking is a pause they hear.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../util/log.ts";

export type Transcript = { text: string; ms: number };

type Pending = {
  resolve: (result: Transcript | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** 16 kHz mono 16-bit: 32 samples per millisecond of audio, as bytes. */
const BYTES_PER_MS = 32;

export class Transcriber {
  private readonly script = resolve(dirname(fileURLToPath(import.meta.url)), "transcriber.py");
  private proc: ChildProcessWithoutNullStreams | null = null;
  private booted: Promise<boolean> | null = null;
  private stopped = false;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly options: {
      python: string;
      /** Hugging Face id; empty uses the script's default. */
      model?: string;
      /** Longest a boot may take before requests stop waiting for it. */
      bootMs?: number;
    },
  ) {}

  /** Its python and script are on this machine. */
  installed(): boolean {
    return existsSync(this.options.python) && existsSync(this.script);
  }

  /** Load the model now. Resolves false if it could not. */
  start(): Promise<boolean> {
    if (this.stopped || !this.installed()) return Promise.resolve(false);
    this.booted ??= this.spawn();
    return this.booted;
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
    this.booted = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      this.pending.delete(id);
    }
  }

  /** True once the model is loaded and answering. */
  ready(): boolean {
    return this.proc !== null && this.booted !== null;
  }

  /**
   * The words in `pcm` (16 kHz mono 16-bit), "" for none, or null when the
   * model could not say. A dead process is started again here and the
   * request waits for it, so a crash between turns costs nothing.
   */
  async transcribe(pcm: Uint8Array): Promise<Transcript | null> {
    if (this.stopped || pcm.byteLength === 0) return null;
    if (!(await this.start())) return null;
    const proc = this.proc;
    if (!proc) return null;
    const id = String(++this.sequence);
    // Generous: Parakeet runs at ~0.05x real time, so this only ever fires on
    // a wedged process, which is then replaced.
    const timeoutMs = 3_000 + (pcm.byteLength / BYTES_PER_MS) * 0.5;
    return new Promise((resolveText) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        log.warn("transcriber", "no answer; replacing it", { ms: Math.round(timeoutMs) });
        this.replace(proc);
        resolveText(null);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveText, timer });
      proc.stdin.write(`${JSON.stringify({ id, pcm: Buffer.from(pcm).toString("base64") })}\n`);
    });
  }

  private replace(proc: ChildProcessWithoutNullStreams): void {
    if (this.proc !== proc) return;
    proc.kill();
    this.proc = null;
    this.booted = null;
  }

  private spawn(): Promise<boolean> {
    const args = [this.script, ...(this.options.model ? [this.options.model] : [])];
    const proc = spawn(this.options.python, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.buffer = "";
    return new Promise((resolveBoot) => {
      const timer = setTimeout(() => {
        log.warn("transcriber", "did not boot in time", { ms: this.options.bootMs ?? 30_000 });
        this.replace(proc);
        resolveBoot(false);
      }, this.options.bootMs ?? 30_000);
      proc.stdout.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
          const line = this.buffer.slice(0, i);
          this.buffer = this.buffer.slice(i + 1);
          let message: { id?: string; ok?: boolean; text?: string; ms?: number; error?: string };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id === "boot") {
            clearTimeout(timer);
            if (message.ok) log.info("transcriber", "ready", { boot_ms: message.ms });
            else {
              log.warn("transcriber", "failed to start", { error: message.error });
              this.replace(proc);
            }
            resolveBoot(message.ok === true);
            continue;
          }
          this.settle(message);
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => log.debug("transcriber", String(chunk).trim()));
      proc.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolveBoot(false);
        if (this.proc !== proc) return;
        this.proc = null;
        this.booted = null;
        // Whatever it was working on is lost; say so now rather than at the timeout.
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.resolve(null);
          this.pending.delete(id);
        }
        if (!this.stopped) log.warn("transcriber", "exited", { code, signal });
      });
    });
  }

  private settle(message: { id?: string; ok?: boolean; text?: string; ms?: number }): void {
    const pending = message.id ? this.pending.get(message.id) : undefined;
    if (!pending || !message.id) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(
      message.ok && typeof message.text === "string"
        ? { text: message.text, ms: message.ms ?? 0 }
        : null,
    );
  }
}
