/**
 * The harness's one surface onto Messages.app.
 *
 * Everything that reaches Messages goes through {@link invoke}. The daemon owns
 * a supervised imcore-bridge; every other process reaches it over the control
 * socket. There is no second delivery path — no CLI to shell out to, no
 * AppleScript, no legacy sender to fall back to — so a failure is visible where
 * it happens instead of being absorbed by a path that half works.
 *
 * Only what callers outside this directory need is re-exported. The operation
 * vocabulary itself lives in `protocol.ts` and is internal: adding an operation
 * should not mean widening this surface.
 */
export { invoke } from "./route.ts";
export {
  bridge,
  healMessagingRegistry,
  isBridgeHost,
  relaunchBridge,
  startBridge,
  stopBridge,
} from "./host.ts";
export { serveBridgeControl } from "./control-server.ts";
export { controlSocketPath } from "./socket-path.ts";
