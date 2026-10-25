import { type ChildProcess, spawn } from "node:child_process";

/**
 * The printer's camera. The P2S serves H.264 over RTSPS on port 322 (live555,
 * 1920x1080) once "LAN Only Liveview" is on in its network settings; it has
 * no JPEG service like the P1 and A1. ffmpeg does the RTSP and decoding and
 * hands back JPEG frames on stdout, which this module cuts apart at the JPEG
 * start and end markers.
 *
 * The printer allows two camera streams at once, and Bambu Handy can be one
 * of them, so the feed runs only while someone is looking and stops itself
 * after a quiet spell.
 */

export const FFMPEG = process.env.EDMUND_FFMPEG || "/opt/homebrew/bin/ffmpeg";

export function rtspUrl(host: string, accessCode: string): string {
  return `rtsps://bblp:${encodeURIComponent(accessCode)}@${host}:322/streaming/live/1`;
}

/** Pull complete JPEGs out of a byte stream; returns the frames and the unfinished tail. */
export function cutJpegs(buf: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let start = buf.indexOf(Buffer.from([0xff, 0xd8]));
  while (start !== -1) {
    const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end === -1) break;
    frames.push(Buffer.from(buf.subarray(start, end + 2)));
    start = buf.indexOf(Buffer.from([0xff, 0xd8]), end + 2);
  }
  const keepFrom = start === -1 ? buf.length : start;
  return { frames, rest: Buffer.from(buf.subarray(keepFrom)) };
}

function ffmpegArgs(url: string, fps: number, single: boolean): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-i",
    url,
    "-an",
    "-vf",
    `fps=${fps},scale=1280:-2`,
    ...(single ? ["-frames:v", "1"] : []),
    "-q:v",
    "4",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-",
  ];
}

export class CameraFeed {
  private proc: ChildProcess | null = null;
  private latest: { jpeg: Buffer; ms: number } | null = null;
  private lastWanted = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private waiters: Array<(f: { jpeg: Buffer; ms: number } | null) => void> = [];
  private lastError = "";

  constructor(
    private readonly opts: {
      host: string;
      accessCode: string;
      fps: number;
      /** Stop the stream after this long with nobody asking for a frame. */
      idleMs?: number;
    },
  ) {}

  get error(): string {
    return this.lastError;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** The newest frame no older than `maxAgeMs`, starting the stream if needed. */
  async frame(maxAgeMs = 3_000, timeoutMs = 20_000): Promise<{ jpeg: Buffer; ms: number }> {
    this.lastWanted = Date.now();
    if (this.latest && Date.now() - this.latest.ms <= maxAgeMs) return this.latest;
    this.start();
    const got = await new Promise<{ jpeg: Buffer; ms: number } | null>((resolve) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(null);
      }, timeoutMs);
      const done = (f: { jpeg: Buffer; ms: number } | null) => {
        clearTimeout(t);
        resolve(f);
      };
      this.waiters.push(done);
    });
    if (!got) {
      throw new Error(
        this.lastError ||
          "the camera sent no picture (is LAN Only Liveview on in the printer's network settings?)",
      );
    }
    return got;
  }

  private start() {
    if (this.proc) return;
    const proc = spawn(
      FFMPEG,
      ffmpegArgs(rtspUrl(this.opts.host, this.opts.accessCode), this.opts.fps, false),
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.proc = proc;
    let buf: Buffer = Buffer.alloc(0);
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      const { frames, rest } = cutJpegs(Buffer.concat([buf, d]));
      buf = rest;
      const last = frames.at(-1);
      if (!last) return;
      this.latest = { jpeg: last, ms: Date.now() };
      this.lastError = "";
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f(this.latest);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      if (code && code !== 255) this.lastError = describeFfmpegError(stderr);
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f(null);
    });
    proc.on("error", (e) => {
      this.lastError = `could not run ffmpeg: ${e.message}`;
    });
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => {
        if (this.proc && Date.now() - this.lastWanted > (this.opts.idleMs ?? 45_000))
          this.stopStream();
      }, 5_000);
    }
  }

  private stopStream() {
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }

  stop() {
    this.stopStream();
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}

export function describeFfmpegError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("connection refused")) {
    return "the camera stream is off: turn on LAN Only Liveview in the printer's network settings";
  }
  if (s.includes("401") || s.includes("unauthorized")) return "the camera refused the access code";
  if (s.includes("timed out") || s.includes("timeout")) return "the camera did not answer";
  const last = stderr.trim().split("\n").at(-1) ?? "";
  return last ? `camera error: ${last.slice(0, 200)}` : "the camera stream ended";
}

/** One frame, without keeping a stream open. For the tool process when the daemon is not reachable. */
export function grabFrame(host: string, accessCode: string, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ffmpegArgs(rtspUrl(host, accessCode), 2, true), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let stderr = "";
    const t = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(describeFfmpegError(`${stderr}\ntimed out`)));
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => out.push(d));
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`could not run ffmpeg: ${e.message}`));
    });
    proc.on("exit", () => {
      clearTimeout(t);
      const { frames } = cutJpegs(Buffer.concat(out));
      if (frames[0]) resolve(frames[0]);
      else reject(new Error(describeFfmpegError(stderr)));
    });
  });
}
