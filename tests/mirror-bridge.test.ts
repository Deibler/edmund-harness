import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorBridge } from "../integrations/mirror/src/bridge.ts";
import { MirrorStore } from "../integrations/mirror/src/store.ts";
import type { Config } from "../src/config/config.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MirrorBridge v2", () => {
  test("authenticates by subprotocol, snapshots first, and retires deltas only after ack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edmund-mirror-bridge-"));
    dirs.push(dir);
    const store = new MirrorStore(dir);
    store.upsertContent({
      id: "brief:test",
      page: "home",
      zone: "lower_third",
      component: "text_block",
      props: { text: "Reliable bridge" },
      lifespan: "session",
      expiresAtMs: null,
    });

    const frames: Array<Record<string, unknown>> = [];
    const closes: string[] = [];
    let requestUrl = "";
    let protocols = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        requestUrl = request.url;
        protocols = request.headers.get("sec-websocket-protocol") ?? "";
        if (
          bunServer.upgrade(request, {
            headers: { "Sec-WebSocket-Protocol": "constellation-mirror-v2" },
          })
        ) {
          return;
        }
        return new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(socket) {
          socket.send(
            JSON.stringify({
              v: 2,
              type: "hello",
              node: "test-pi",
              revision: 0,
              protocol: 2,
            }),
          );
        },
        message(socket, raw) {
          const frame = JSON.parse(String(raw)) as Record<string, unknown>;
          frames.push(frame);
          socket.send(
            JSON.stringify({
              v: 2,
              type: "ack",
              replyTo: frame.id,
              status: "accepted",
              revision: frame.revision ?? 0,
            }),
          );
        },
      },
    });

    const token = "bridge-test-household-token";
    const config = {
      mirror: {
        host: "127.0.0.1",
        port: server.port,
        token,
      },
    } as Config;
    const bridge = new MirrorBridge(config, store, {
      onCloseConversation: (requestId) => closes.push(requestId),
    });
    try {
      bridge.start();
      await until(() => frames.some((frame) => frame.type === "content_upsert"));

      expect(new URL(requestUrl).search).toBe("");
      expect(protocols.split(",").map((value) => value.trim())).toEqual([
        "constellation-mirror-v2",
        `bearer.${Buffer.from(token).toString("base64url")}`,
      ]);
      expect(frames[0]?.type).toBe("snapshot");
      expect(frames.find((frame) => frame.type === "content_upsert")).toMatchObject({
        revision: 1,
        content: { id: "brief:test" },
      });
      await until(() => store.listReadyOutbox().length === 0);

      const overlay = await bridge.setOverlay({ phase: "showing", botText: "Hello" });
      expect(overlay).toEqual({ delivered: true });

      const closeId = store.enqueueLocalClose();
      await until(() => closes.length === 1);
      expect(closes).toEqual([closeId]);
      await until(() => store.listReadyOutbox().length === 0);
    } finally {
      bridge.stop();
      store.close();
      server.stop(true);
    }
  });
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for mirror bridge state");
    await Bun.sleep(10);
  }
}
