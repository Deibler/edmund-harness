// Stands in for scripts/camera-host.ts: prints its port, serves a fixed still
// to callers with the secret, and exits on SIGTERM.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/snapshot.jpg") return new Response("Not found", { status: 404 });
    if (req.headers.get("x-camera-secret") !== process.env.EDMUND_CAMERA_SECRET)
      return new Response("Forbidden", { status: 403 });
    return new Response(new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), {
      headers: { "Content-Type": "image/jpeg", "X-Frame-Ms": "1234" },
    });
  },
});
process.stdout.write(`${JSON.stringify({ port: server.port })}\n`);
process.on("SIGTERM", () => process.exit(0));
