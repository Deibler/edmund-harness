/**
 * Has the caller finished their turn? The client for turn-detector.py, which
 * runs Smart Turn v3 on the last 8 s of their speech.
 *
 * Never in the way of a call: a missing model, a sidecar still booting, a
 * crash or a slow answer all come back as null, and the call manager falls
 * back to its fixed silence timer. A missing turn detector costs speed, never
 * a call. Started with the call runtime and kept resident: it is ~9 MB and
 * nothing on a call should wait for something to load.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../util/log.ts";

export type TurnVerdict = { probability: number; ms: number };

type Pending = {
  resolve: (verdict: TurnVerdict | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class TurnDetector {
  private readonly script = resolve(dirname(fileURLToPath(import.meta.url)), "turn-detector.py");
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private stopped = false;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private lastSpawnMs = 0;

  constructor(
    private readonly options: {
      python: string;
      model: string;
      /** Longest a verdict may take before the call stops waiting for it. */
      timeoutMs?: number;
    },
  ) {}

  /** Its python and model are on this machine. */
  installed(): boolean {
    return (
      existsSync(this.options.python) && existsSync(this.options.model) && existsSync(this.script)
    );
  }

  start(): void {
    if (!this.stopped && this.installed() && !this.proc) this.spawn();
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      this.pending.delete(id);
    }
  }

  /** The probability that the turn is over, for base64 16 kHz mono 16-bit PCM. */
  async verdict(pcmBase64: string): Promise<TurnVerdict | null> {
    if (this.stopped || !pcmBase64) return null;
    if (!this.proc) {
      // Respawn after a crash, but not in a tight loop.
      if (Date.now() - this.lastSpawnMs < 5_000 || !this.installed()) return null;
      this.spawn();
    }
    if (!this.ready || !this.proc) return null;
    const id = String(++this.sequence);
    return new Promise((resolveVerdict) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolveVerdict(null);
      }, this.options.timeoutMs ?? 400);
      this.pending.set(id, { resolve: resolveVerdict, timer });
      this.proc?.stdin.write(`${JSON.stringify({ id, pcm: pcmBase64 })}\n`);
    });
  }

  private spawn(): void {
    this.lastSpawnMs = Date.now();
    this.ready = false;
    const proc = spawn(this.options.python, [this.script, this.options.model], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.onLine(line);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      log.debug("turn", String(chunk).trim());
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.ready = false;
      if (!this.stopped) log.warn("turn", "turn detector exited", { code, signal });
    });
  }

  private onLine(line: string): void {
    let message: { id?: string; ok?: boolean; probability?: number; ms?: number; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === "boot") {
      this.ready = message.ok === true;
      if (this.ready) log.info("turn", "turn detector ready", { model: this.options.model });
      else log.warn("turn", "turn detector failed to start", { error: message.error });
      return;
    }
    const pending = message.id ? this.pending.get(message.id) : undefined;
    if (!pending || !message.id) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.resolve(
      message.ok && typeof message.probability === "number"
        ? { probability: message.probability, ms: message.ms ?? 0 }
        : null,
    );
  }
}
