import { callBridgeControl } from "./control-client.ts";
import { bridge, isBridgeHost } from "./host.ts";
import { runOp } from "./ops.ts";
import type { BridgeOp, OpArgs, OpResult } from "./protocol.ts";
import { controlSocketPath } from "./socket-path.ts";

/**
 * Performs an operation on Messages, wherever the caller happens to be running.
 *
 * The daemon holds the bridge and runs the operation directly. Everything else —
 * the MCP server spawned per `claude -p` run, one-off scripts — reaches the same
 * operation over the daemon's control socket. Callers do not branch on which
 * they are, so no call site has to know, and none of them can accidentally grow
 * a second way to talk to Messages.
 *
 * This is the whole surface between the harness and Messages.app. There is no
 * path around it and no fallback beneath it: if the operation cannot be
 * performed, the error reaches the caller.
 */
export function invoke<K extends BridgeOp>(op: K, args: OpArgs<K>): Promise<OpResult<K>> {
  if (isBridgeHost()) return runOp(bridge(), op, args);
  return callBridgeControl(controlSocketPath(), op, args);
}
