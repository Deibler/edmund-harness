import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CameraHostProcess,
  START_OFFSET_S,
  cameraHandler,
  liveTokenReader,
  withStartOffset,
  writeLiveTokens,
} from "../src/camera-server.ts";
import { ffmpegArgs, playlistSegments } from "../src/camera.ts";
import { HLS_JS, THREE_JS, renderPage } from "../src/page.ts";

const dir = mkdtempSync(join(tmpdir(), "printer-camera-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LIVE = "a".repeat(32);
const OTHER = "b".repeat(32);
const SECRET = "s3cret";
const PLAYLIST =
  '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1.0,\ns100.m4s\n#EXTINF:1.0,\ns101.m4s\n';

function handler(over: { playlist?: string | null } = {}) {
  let touched = 0;
  const h = cameraHandler({
    feed: {
      frame: async () => ({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), ms: 42 }),
      touch: () => {
        touched++;
      },
      playlist: async () => (over.playlist === undefined ? PLAYLIST : over.playlist),
    },
    dir,
    secret: SECRET,
    isLive: (t) => t === LIVE,
  });
  return { h, touched: () => touched };
}

const get = (
  h: (r: Request) => Promise<Response>,
  path: string,
  headers?: Record<string, string>,
) => h(new Request(`http://127.0.0.1${path}`, { headers }));

describe("the camera stream", () => {
  test("the video is the camera's own H.264, cut on its keyframes, numbered from the clock", () => {
    const args = ffmpegArgs("rtsps://x", 1, false, "/tmp/live");
    const s = args.join(" ");
    expect(s).toContain("-c:v copy");
    expect(s).toContain("-hls_time 2");
    expect(s).toContain("-hls_list_size 10");
    expect(s).toContain("-hls_delete_threshold 6");
    // A camera that goes quiet with the connection open must not hang ffmpeg.
    expect(args.indexOf("-timeout")).toBeLessThan(args.indexOf("-i"));
    expect(s).toContain("-hls_start_number_source epoch");
    expect(s).toContain("-hls_segment_type fmp4");
    // Stills decode keyframes only, and that must come before the input.
    expect(args.indexOf("-skip_frame")).toBeLessThan(args.indexOf("-i"));
    expect(s).toContain("-skip_frame nokey");
    expect(args).toContain("/tmp/live/index.m3u8");
    // The stills still come out of the same process.
    expect(args.at(-1)).toBe("-");
    expect(ffmpegArgs("rtsps://x", 1, true).join(" ")).not.toContain("hls");
  });

  test("the playlist's segments are read from its lines", () => {
    expect(playlistSegments(PLAYLIST)).toEqual(["s100.m4s", "s101.m4s"]);
  });
});

describe("the camera host's routes", () => {
  test("a live page gets the playlist", async () => {
    const r = await get(handler().h, `/printcam/${LIVE}/index.m3u8`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(r.headers.get("cache-control")).toBe("no-store");
    // Players are told to start behind live, so they hold a buffer.
    expect(await r.text()).toBe(withStartOffset(PLAYLIST));
    expect(withStartOffset(PLAYLIST).split("\n").slice(0, 2)).toEqual([
      "#EXTM3U",
      `#EXT-X-START:TIME-OFFSET=-${START_OFFSET_S.toFixed(1)}`,
    ]);
    expect(withStartOffset(withStartOffset(PLAYLIST))).toBe(withStartOffset(PLAYLIST));
  });

  test("a page that is not live gets nothing", async () => {
    const { h } = handler();
    expect((await get(h, `/printcam/${OTHER}/index.m3u8`)).status).toBe(404);
    writeFileSync(join(dir, "s100.m4s"), "seg");
    expect((await get(h, `/printcam/${OTHER}/s100.m4s`)).status).toBe(404);
  });

  test("segments are served, and only files the stream writes", async () => {
    const { h, touched } = handler();
    writeFileSync(join(dir, "s100.m4s"), "seg");
    writeFileSync(join(dir, "secret.txt"), "no");
    const r = await get(h, `/printcam/${LIVE}/s100.m4s`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(await r.text()).toBe("seg");
    expect(touched()).toBe(1);
    for (const bad of ["secret.txt", "..%2Fsecret.txt", "s100.m4s.tmp", "index.m3u8x"]) {
      expect([bad, (await get(h, `/printcam/${LIVE}/${bad}`)).status]).toEqual([bad, 404]);
    }
  });

  test("no picture yet is a 503, not a hang", async () => {
    const r = await get(handler({ playlist: null }).h, `/printcam/${LIVE}/index.m3u8`);
    expect(r.status).toBe(503);
  });

  test("a still needs the secret", async () => {
    const { h } = handler();
    expect((await get(h, "/snapshot.jpg")).status).toBe(403);
    const r = await get(h, "/snapshot.jpg", { "x-camera-secret": SECRET });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-frame-ms")).toBe("42");
  });
});

describe("which pages are live", () => {
  test("the camera host follows the runtime's list as it changes", async () => {
    const path = join(dir, "live-tokens.json");
    const isLive = liveTokenReader(path);
    expect(isLive(LIVE)).toBe(false);
    writeLiveTokens(path, [LIVE]);
    expect(isLive(LIVE)).toBe(true);
    await Bun.sleep(20);
    writeLiveTokens(path, []);
    expect(isLive(LIVE)).toBe(false);
  });
});

describe("the daemon's side", () => {
  test("starts the host, learns its port, and reads stills from it", async () => {
    let mounted = 0;
    const host = new CameraHostProcess({
      script: join(import.meta.dir, "fixtures", "fake-camera-host.ts"),
      env: { EDMUND_CAMERA_SECRET: SECRET },
      secret: SECRET,
      onPort: (p) => {
        mounted = p;
      },
      log: () => {},
    });
    host.start();
    try {
      const f = await host.frame(0, 5_000);
      expect([...f.jpeg]).toEqual([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
      expect(f.ms).toBe(1234);
      expect(mounted).toBeGreaterThan(0);
    } finally {
      host.stop();
    }
  });
});

describe("one camera connection", () => {
  test("only the camera host opens the camera stream", () => {
    const root = join(import.meta.dir, "..");
    const files = [
      ...readdirSync(join(root, "src")).map((f) => join(root, "src", f)),
      ...readdirSync(join(root, "scripts")).map((f) => join(root, "scripts", f)),
      join(root, "tools.ts"),
      join(root, "index.ts"),
    ].filter((f) => f.endsWith(".ts"));
    const opens = files.filter((f) => /new CameraFeed\(/.test(readFileSync(f, "utf8")));
    expect(opens.map((f) => f.slice(root.length + 1))).toEqual(["scripts/camera-host.ts"]);
  });
});

describe("the page", () => {
  test("plays the video and keeps the still as the stand-in", () => {
    const html = renderPage({
      title: "Test",
      requester: "",
      printer: "the P2S",
      phase: "printing",
      phaseLabel: "Printing",
      stage: "",
      percent: 10,
      layer: 1,
      totalLayers: 10,
      remainingMin: 5,
      etaMs: null,
      startedMs: null,
      endedMs: null,
      nozzle: { temp: null, target: null },
      bed: { temp: null, target: null },
      speed: "",
      filaments: [],
      estimateS: 0,
      live: true,
      hasPreview: false,
      hasFinalPhoto: false,
      hasTimelapse: false,
      updatedMs: 0,
    } as Parameters<typeof renderPage>[0]);
    expect(html).toContain('<video id="video"');
    expect(html).toContain("playsinline");
    expect(html).toContain('"/printcam/" + token + "/index.m3u8"');
    expect(html).toContain('location.pathname.split("/")[2]');
    // Full screen: the system player on an iPhone, the whole view elsewhere.
    expect(html).toContain("webkitEnterFullscreen");
    expect(html).toContain("requestFullscreen");
    // The 3D view: pinned three.js behind an import map, loaded on demand.
    const map = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/)![1]!);
    expect(map.imports.three).toBe(THREE_JS.module);
    expect(map.imports[THREE_JS.core]).toBe(THREE_JS.coreMin);
    expect(Object.keys(map.integrity).sort()).toEqual(Object.keys(THREE_JS.integrity).sort());
    expect(THREE_JS.module).toMatch(/three@\d+\.\d+\.\d+\//);
    expect(html).toContain('id="tabModel"');
    expect(html).toContain('fetch("viewer.json"');
    expect(html).toContain('id="frame"');
    expect(html).toContain(HLS_JS.integrity);
    expect(HLS_JS.src).toMatch(/hls\.js@\d+\.\d+\.\d+\//);
  });
});
