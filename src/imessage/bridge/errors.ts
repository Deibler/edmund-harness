import type { WireError } from "./protocol.ts";

/**
 * Failures of the harness's own plumbing, as opposed to failures Messages
 * reported. imcore-bridge already distinguishes its own — an unsupported
 * selector, a wedged host, a chat that does not exist — and those are passed
 * through untouched rather than reclassified here.
 *
 * Nothing in this layer degrades to a second delivery path. A send that cannot
 * be made is an error the caller sees, because a fallback that quietly half
 * works is how a broken bridge stayed broken for a day without anyone noticing.
 */
class BridgeError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** This process should own the bridge but it has not been started. */
export class BridgeNotRunningError extends BridgeError {
  constructor(message = "the Messages bridge is not running in this process") {
    super(message, "bridge_not_running");
  }
}

/**
 * The daemon's control socket could not be reached.
 *
 * Raised in a `claude -p` subprocess when the daemon is down, restarting, or
 * was started without the control server. Deliberately loud: the alternative is
 * a tool reporting a message sent that no one will ever receive.
 */
export class ControlUnreachableError extends BridgeError {
  constructor(
    readonly socketPath: string,
    detail: string,
  ) {
    super(
      `cannot reach the daemon's Messages control socket at ${socketPath} (${detail})`,
      "control_unreachable",
    );
  }
}

/** Rebuilds an error that crossed the control socket, preserving its identity. */
export function errorFromWire(wire: WireError): Error {
  const error = new BridgeError(wire.message, wire.code);
  // Keep the original class name so callers matching on it still match, even
  // though the class itself does not exist on this side of the socket.
  error.name = wire.name || "BridgeError";
  return error;
}

/** Flattens an error for the wire, keeping the fields the far side branches on. */
export function errorToWire(error: unknown): WireError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      code: (error as { code?: string }).code,
    };
  }
  return { message: String(error), name: "Error" };
}
