import { cameraHandler, liveTokenReader } from "../src/camera-server.ts";
/**
 * The camera host process, started and kept running by the printer runtime
 * (src/camera-server.ts explains why it is separate). Configuration arrives in
 * the environment, so the access code never appears in a process listing.
 * Prints {"port":N} once listening; exits when the daemon that started it is
 * gone.
 */
import { CameraFeed } from "../src/camera.ts";

const env = process.env;
const dir = env.EDMUND_CAMERA_DIR ?? "";
const tokens = env.EDMUND_CAMERA_TOKENS ?? "";
if (
  !env.EDMUND_CAMERA_HOST ||
  !env.EDMUND_CAMERA_CODE ||
  !dir ||
  !tokens ||
  !env.EDMUND_CAMERA_SECRET
) {
  console.error("[camera-host] missing configuration");
  process.exit(2);
}

const feed = new CameraFeed({
  host: env.EDMUND_CAMERA_HOST,
  accessCode: env.EDMUND_CAMERA_CODE,
  fps: Number(env.EDMUND_CAMERA_FPS ?? 1),
  hlsDir: dir,
  idleMs: 60_000,
  log: (m) => console.error(`[camera-host] ${m}`),
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // A cold start waits for the camera's first keyframes; never cut that off.
  idleTimeout: 60,
  fetch: cameraHandler({
    feed,
    dir,
    secret: env.EDMUND_CAMERA_SECRET,
    isLive: liveTokenReader(tokens),
  }),
});
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);

const parent = process.ppid;
const quit = () => {
  feed.stop();
  server.stop(true);
  process.exit(0);
};
process.on("SIGTERM", quit);
process.on("SIGINT", quit);
// If the daemon dies without stopping us, launchd adopts us; do not linger
// holding the printer's camera.
setInterval(() => {
  if (process.ppid !== parent) quit();
}, 2_000);
