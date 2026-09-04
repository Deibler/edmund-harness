import net from "node:net";

import { ControlUnreachableError, errorFromWire } from "./errors.ts";
import {
  type BridgeOp,
  type ControlResponse,
  MAX_FRAME_BYTES,
  type OpArgs,
  type OpResult,
} from "./protocol.ts";

/**
 * Reaches the daemon's bridge from a process that does not hold it.
 *
 * One connection per request, deliberately. These calls are infrequent — a
 * subprocess sends a handful of messages over its life — and a pooled
 * connection would need its own liveness handling to avoid the exact failure
 * this migration is about: a socket that looks open and answers nothing.
 *
 * There is no local fallback. If the daemon cannot be reached the call fails and
 * the caller reports it, because a tool that claims to have sent a message no
 * one will receive is worse than one that says it could not.
 */
export interface ControlClientOptions {
  /** How long to wait for the whole round trip. Defaults to 45000. */
  timeoutMs?: number;
}

export async function callBridgeControl<K extends BridgeOp>(
  socketPath: string,
  op: K,
  args: OpArgs<K>,
  options: ControlClientOptions = {},
): Promise<OpResult<K>> {
  // Native sends may legitimately use their full 30s main-thread budget.
  // Leave room for framing/control dispatch so this outer timeout never wins
  // a race against the operation it is transporting.
  const timeoutMs = options.timeoutMs ?? 45_000;

  return new Promise<OpResult<K>>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new ControlUnreachableError(socketPath, `no answer to '${op}' within ${timeoutMs}ms`),
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    socket.on("error", (err) => {
      settle(() => reject(new ControlUnreachableError(socketPath, err.message)));
    });

    // A close before an answer means the daemon went away mid-request. Saying so
    // is better than resolving as though the send had happened.
    socket.on("close", () => {
      settle(() =>
        reject(
          new ControlUnreachableError(socketPath, `connection closed before '${op}' answered`),
        ),
      );
    });

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, op, args })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_FRAME_BYTES) {
        settle(() => reject(new ControlUnreachableError(socketPath, "oversized reply")));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      const line = buffer.slice(0, newline);
      let response: ControlResponse;
      try {
        response = JSON.parse(line) as ControlResponse;
      } catch {
        settle(() => reject(new ControlUnreachableError(socketPath, "unparseable reply")));
        return;
      }

      settle(() => {
        if (response.ok) resolve(response.result as OpResult<K>);
        else reject(errorFromWire(response.error));
      });
    });
  });
}
