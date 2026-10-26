import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { atomicWriteFileSync } from "../../../src/util/atomic-write.ts";
import type { CameraFeed } from "./camera.ts";

/**
 * The camera host: a process of its own that owns the one camera connection,
 * serves the live page's video, and hands the daemon its stills.
 *
 * It is separate from the daemon so that nothing the daemon does can stall
 * the video: the page used to poll a JPEG from the daemon's own event loop,
 * which froze whenever a turn or a recall search held that loop, and a cold
 * start could outlast the kitchen host's 10 s request limit.
 *
 * Routes:
 *   /printcam/<token>/index.m3u8, init.mp4, s<n>.m4s   the video, for live jobs
 *   /snapshot.jpg?maxAgeMs=&timeoutMs=                   a still, with the secret
 */

const SEGMENT = /^(index\.m3u8|init\.mp4|s\d+\.m4s)$/;

export type CameraDeps = {
  feed: Pick<CameraFeed, "frame" | "touch" | "playlist">;
  dir: string;
  secret: string;
  isLive: (token: string) => boolean;
};

export function cameraHandler(deps: CameraDeps): (req: Request) => Promise<Response> {
  const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/snapshot.jpg") {
      if (req.headers.get("x-camera-secret") !== deps.secret)
        return new Response("Forbidden", { status: 403 });
      try {
        const f = await deps.feed.frame(
          Number(url.searchParams.get("maxAgeMs") ?? 3_000),
          Number(url.searchParams.get("timeoutMs") ?? 20_000),
        );
        return new Response(new Uint8Array(f.jpeg), {
          headers: { ...noStore, "Content-Type": "image/jpeg", "X-Frame-Ms": String(f.ms) },
        });
      } catch (e) {
        return new Response((e as Error).message, { status: 503, headers: noStore });
      }
    }
    const m = url.pathname.match(/^\/printcam\/([a-f0-9]{32})\/([^/]+)$/);
    if (!m || !SEGMENT.test(m[2]!)) return new Response("Not found", { status: 404 });
    if (!deps.isLive(m[1]!)) return new Response("Not live", { status: 404, headers: noStore });
    const name = m[2]!;
    if (name === "index.m3u8") {
      const text = await deps.feed.playlist();
      if (!text) return new Response("No picture", { status: 503, headers: noStore });
      return new Response(withStartOffset(text), {
        headers: { ...noStore, "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    deps.feed.touch();
    const path = join(deps.dir, name);
    if (!existsSync(path)) return new Response("Gone", { status: 404, headers: noStore });
    return new Response(Bun.file(path), {
      headers: {
        "Content-Type": "video/mp4",
        // A segment never changes once written; the playlist is what moves.
        "Cache-Control": "private, max-age=30",
        "X-Robots-Tag": "noindex",
      },
    });
  };
}

/**
 * Players start six seconds behind live (three segments), so they hold a
 * buffer to ride out a slow segment instead of stalling at the live edge.
 * Safari and hls.js both honour EXT-X-START; ffmpeg does not write it.
 */
export const START_OFFSET_S = 6;

export function withStartOffset(playlist: string): string {
  if (playlist.includes("#EXT-X-START")) return playlist;
  return playlist.replace(
    /^#EXTM3U\r?\n/,
    `#EXTM3U\n#EXT-X-START:TIME-OFFSET=-${START_OFFSET_S.toFixed(1)}\n`,
  );
}

/** Which job pages may show the camera, as the runtime last decided. */
export function writeLiveTokens(path: string, tokens: string[]): void {
  atomicWriteFileSync(path, JSON.stringify({ tokens, ms: Date.now() }));
}

/** Reads the runtime's list, re-reading only when the file changes. */
export function liveTokenReader(path: string): (token: string) => boolean {
  let seen = -1;
  let tokens = new Set<string>();
  return (token) => {
    try {
      const mtime = statSync(path).mtimeMs;
      if (mtime !== seen) {
        tokens = new Set((JSON.parse(readFileSync(path, "utf8")).tokens as string[]) ?? []);
        seen = mtime;
      }
    } catch {
      tokens = new Set();
      seen = -1;
    }
    return tokens.has(token);
  };
}

/**
 * The daemon's side: starts the camera host, keeps it running, and reads
 * stills from it. Every camera user in the daemon goes through here, so the
 * Mac holds one connection to the printer's camera, not one per user.
 */
export class CameraHostProcess {
  private proc: Subprocess | null = null;
  private portNow = 0;
  private waiting: Array<(port: number) => void> = [];
  private stopped = false;
  private restarts = 0;
  private lastErr = "";

  constructor(
    private readonly opts: {
      script: string;
      env: Record<string, string>;
      secret: string;
      onPort: (port: number) => void;
      log: (msg: string) => void;
    },
  ) {}

  get error(): string {
    return this.lastErr;
  }

  start(): void {
    if (this.proc || this.stopped) return;
    const proc = spawn([process.execPath, this.opts.script], {
      env: { ...process.env, ...this.opts.env },
      stdout: "pipe",
      stderr: "inherit",
    });
    this.proc = proc;
    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        const line = buf.match(/"port":(\d+)/);
        if (line && !this.portNow) {
          this.portNow = Number(line[1]);
          this.restarts = 0;
          this.opts.onPort(this.portNow);
          for (const w of this.waiting.splice(0)) w(this.portNow);
        }
      }
    })();
    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.portNow = 0;
      if (this.stopped) return;
      this.lastErr = `camera host exited (${code})`;
      this.opts.log(this.lastErr);
      const delay = Math.min(30_000, 1_000 * 2 ** this.restarts++);
      setTimeout(() => this.start(), delay).unref?.();
    });
  }

  private port(timeoutMs: number): Promise<number> {
    if (this.portNow) return Promise.resolve(this.portNow);
    this.start();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the camera host is not running")), timeoutMs);
      this.waiting.push((p) => {
        clearTimeout(t);
        resolve(p);
      });
    });
  }

  /** The newest still no older than `maxAgeMs`, starting the camera if needed. */
  async frame(maxAgeMs = 3_000, timeoutMs = 20_000): Promise<{ jpeg: Buffer; ms: number }> {
    const port = await this.port(5_000);
    const res = await fetch(
      `http://127.0.0.1:${port}/snapshot.jpg?maxAgeMs=${maxAgeMs}&timeoutMs=${timeoutMs}`,
      {
        headers: { "x-camera-secret": this.opts.secret },
        signal: AbortSignal.timeout(timeoutMs + 5_000),
      },
    );
    if (!res.ok) throw new Error((await res.text()) || `camera host answered ${res.status}`);
    return {
      jpeg: Buffer.from(await res.arrayBuffer()),
      ms: Number(res.headers.get("x-frame-ms") ?? Date.now()),
    };
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this.portNow = 0;
  }
}
