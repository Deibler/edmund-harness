import fs from "node:fs";
import net from "node:net";
import { dirname } from "node:path";

import type { ImcoreBridge } from "imcore-bridge";

import { log } from "../../util/log.ts";
import { errorToWire } from "./errors.ts";
import { bridge } from "./host.ts";
import { isBridgeOp, runOp } from "./ops.ts";
import { type ControlResponse, MAX_FRAME_BYTES } from "./protocol.ts";
import { publishControlSocketPath } from "./socket-path.ts";

/**
 * Serves the daemon's bridge to the rest of the harness.
 *
 * A `claude -p` subprocess cannot own the bridge — the socket the injected code
 * dials takes a single owner — so its sends arrive here and run against the one
 * bridge that exists. Requests are newline-delimited JSON, answered by id, and
 * concurrent requests on one connection are fine because nothing is serialised
 * beyond what IMCore itself serialises.
 *
 * Local-only by construction: a unix socket at 0600 inside the harness's data
 * directory. Anything that can write to it can send messages as the operator,
 * which is the same trust boundary as the bridge socket itself.
 */
export interface ControlServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface ControlServerOptions {
  /**
   * Where to get the bridge each request runs against. Defaults to the one this
   * process supervises; injected in tests, and the seam that keeps this file
   * from depending on a live Messages.app to be exercised.
   */
  resolveBridge?: () => ImcoreBridge;
}

export async function serveBridgeControl(
  socketPath: string,
  options: ControlServerOptions = {},
): Promise<ControlServer> {
  const resolveBridge = options.resolveBridge ?? bridge;
  fs.mkdirSync(dirname(socketPath), { recursive: true });
  // A socket file left by a daemon that did not exit cleanly would block bind().
  // Removing it is safe: a live daemon holds the bridge socket too, and two
  // daemons are already prevented upstream.
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* nothing to clean up */
  }

  const connections = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    // A caller that dies mid-request must not take the daemon with it.
    socket.on("error", (err) => {
      log.debug("bridge-control", "connection error", { err: err.message });
      socket.destroy();
    });
    attach(socket, resolveBridge);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });

  publishControlSocketPath(socketPath);
  log.info("bridge-control", "listening", { socket: socketPath });

  return {
    socketPath,
    async close() {
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Reads newline-delimited requests off one connection and answers each. */
function attach(socket: net.Socket, resolveBridge: () => ImcoreBridge): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_FRAME_BYTES) {
      log.warn("bridge-control", "dropping oversized frame", { bytes: buffer.length });
      buffer = "";
      socket.destroy();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) void handle(socket, line, resolveBridge);
    }
  });
}

async function handle(
  socket: net.Socket,
  line: string,
  resolveBridge: () => ImcoreBridge,
): Promise<void> {
  let id = 0;
  try {
    const request = JSON.parse(line) as { id?: unknown; op?: unknown; args?: unknown };
    id = typeof request.id === "number" ? request.id : 0;

    if (!isBridgeOp(request.op)) {
      reply(socket, {
        id,
        ok: false,
        error: { message: `unknown operation '${String(request.op)}'`, name: "BridgeError" },
      });
      return;
    }

    // `runOp` is typed per operation; the wire cannot be, so this is the one
    // place the two meet. The far side built the payload from the same OpMap.
    const result = await runOp(resolveBridge(), request.op, request.args as never);
    reply(socket, { id, ok: true, result: result ?? null });
  } catch (error) {
    reply(socket, { id, ok: false, error: errorToWire(error) });
  }
}

function reply(socket: net.Socket, response: ControlResponse): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(response)}\n`);
}
