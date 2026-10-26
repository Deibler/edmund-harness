import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * The printer's camera. The P2S serves H.264 over RTSPS on port 322 (live555,
 * 1920x1080) once "LAN Only Liveview" is on in its network settings; it has
 * no JPEG service like the P1 and A1. ffmpeg does the RTSP and decoding and
 * hands back JPEG frames on stdout, which this module cuts apart at the JPEG
 * start and end markers.
 *
 * The printer allows two camera streams at once, and Bambu Handy can be one
 * of them, so the feed runs only while someone is looking and stops itself
 * after a quiet spell. One process owns it (scripts/camera-host.ts): the same
 * ffmpeg writes the live page's video as HLS, the camera's own H.264 copied
 * untouched (1080p, 30 fps, a keyframe a second, measured 2026-10-25), and the
 * stills everything else uses.
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

/**
 * The HLS half of a stream: two-second segments (two of the camera's
 * keyframes), a twenty-second window, and old segments kept a while after
 * they leave it, so a player that falls behind finds them rather than a 404.
 * Numbered from the clock, so a restarted stream never goes backwards for a
 * player that is still watching. One-second segments left phones a second of
 * buffer, and any hiccup in the tunnel stalled them.
 */
export function hlsArgs(dir: string): string[] {
  return [
    "-map",
    "0:v",
    "-c:v",
    "copy",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "10",
    "-hls_delete_threshold",
    "6",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "delete_segments+omit_endlist+independent_segments",
    "-hls_start_number_source",
    "epoch",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    join(dir, "s%d.m4s"),
    join(dir, "index.m3u8"),
  ];
}

export function ffmpegArgs(url: string, fps: number, single: boolean, hlsDir?: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    // Stills need only the keyframes (one a second); decoding every frame
    // cost 22% of a core against 5%. The video is copied, never decoded.
    "-skip_frame",
    "nokey",
    // The camera can go quiet with the connection still open (it did,
    // 2026-10-25, when another app opened its live view); without a read
    // timeout ffmpeg waits forever and the picture freezes.
    "-timeout",
    "5000000",
    "-rtsp_transport",
    "tcp",
    "-i",
    url,
    ...(hlsDir ? hlsArgs(hlsDir) : []),
    "-map",
    "0:v",
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

/** Segments the playlist lists right now. */
export function playlistSegments(text: string): string[] {
  return text.split("\n").filter((l) => /^s\d+\.m4s$/.test(l.trim()));
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
      /** Also write the stream as HLS here (the camera host). */
      hlsDir?: string;
      log?: (msg: string) => void;
    },
  ) {}

  private startedMs = 0;
  private lastFrameMs = 0;
  private retryMs = 1_000;

  /** No picture for this long and the stream is presumed stuck. */
  static readonly STALL_MS = 8_000;

  /** Someone is watching the video: keep the stream up, starting it if needed. */
  touch(): void {
    this.lastWanted = Date.now();
    this.start();
  }

  /**
   * The playlist once it lists `minSegments`, starting the stream if needed;
   * null if that does not happen in time. Two segments, so a player that
   * starts at once has something to buffer rather than stalling on the first.
   */
  async playlist(minSegments = 2, timeoutMs = 10_000): Promise<string | null> {
    const dir = this.opts.hlsDir;
    if (!dir) return null;
    const until = Date.now() + timeoutMs;
    for (;;) {
      this.touch();
      const path = join(dir, "index.m3u8");
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        if (playlistSegments(text).length >= minSegments) return text;
      }
      if (Date.now() > until || (!this.proc && this.lastError)) return null;
      await Bun.sleep(150);
    }
  }

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
    const dir = this.opts.hlsDir;
    if (dir) {
      // A restarted stream writes a new playlist. The old one goes, so nobody
      // is handed a timeline that has stopped; recent segments stay for any
      // player still fetching them, and old ones are swept.
      mkdirSync(dir, { recursive: true });
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (f === "index.m3u8" || f.endsWith(".tmp")) unlinkSync(path);
        else if (/^s\d+\.m4s$/.test(f) && Date.now() - statSync(path).mtimeMs > 120_000)
          unlinkSync(path);
      }
    }
    this.startedMs = Date.now();
    const proc = spawn(
      FFMPEG,
      ffmpegArgs(rtspUrl(this.opts.host, this.opts.accessCode), this.opts.fps, false, dir),
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
      this.lastFrameMs = this.latest.ms;
      this.retryMs = 1_000;
      this.lastError = "";
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f(this.latest);
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    proc.on("exit", (code) => {
      const mine = this.proc === proc;
      if (mine) this.proc = null;
      if (code && code !== 255) this.lastError = describeFfmpegError(stderr);
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f(null);
      // Someone is still watching: reconnect, backing off if the camera keeps refusing.
      if (mine && this.wanted()) {
        this.opts.log?.(`camera stream ended (${this.lastError || code}); reconnecting`);
        setTimeout(() => {
          if (this.wanted()) this.start();
        }, this.retryMs).unref?.();
        this.retryMs = Math.min(10_000, this.retryMs * 2);
      }
    });
    proc.on("error", (e) => {
      this.lastError = `could not run ffmpeg: ${e.message}`;
    });
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => {
        if (!this.proc) return;
        if (!this.wanted()) return this.stopStream();
        if (Date.now() - Math.max(this.lastFrameMs, this.startedMs) > CameraFeed.STALL_MS) {
          // The exit handler reconnects, since someone is watching.
          this.lastError = "the camera stopped sending pictures";
          this.proc.kill("SIGKILL");
        }
      }, 2_000);
    }
  }

  private wanted(): boolean {
    return Date.now() - this.lastWanted <= (this.opts.idleMs ?? 45_000);
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
