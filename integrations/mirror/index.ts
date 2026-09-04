/**
 * Smart-mirror integration — public surface.
 *
 * The mirror is a *channel*, not just a tool surface: the user speaks to it,
 * replies are spoken back and drawn on glass, and its sessions flow through
 * the same pipeline iMessage uses. That is why this package receives the
 * host's `channel` capabilities (pipeline, interrupt, lifecycle, deliverer)
 * while ordinary tool integrations do not.
 *
 * The split inside this package matters:
 *   - `src/context.ts`, `src/store.ts`, `src/assets.ts`, `src/protocol.ts`
 *     are the LIGHT surface the core pipeline imports directly (session
 *     detection, envelope block, widget mutations from MCP tools).
 *   - `src/bridge.ts`, `src/orchestrator.ts`, `src/voice.ts`, `src/speech.ts`
 *     are the HEAVY runtime — a WebSocket to the Pi, a Python speech sidecar,
 *     model lifecycle state. Those are imported dynamically below, so a daemon
 *     with the mirror disabled never loads them.
 */

import type { Config } from "../../src/config/config.ts";
import type { IntegrationRuntime, IntegrationRuntimeContext } from "../../src/integrations/host.ts";
import type { SessionKey } from "../../src/sessions/key.ts";
import { log } from "../../src/util/log.ts";
import { mirrorConfig } from "./config.ts";

// Light surface re-exports — what core and the MCP tools consume.
export { mirrorEnvelopeBlock } from "./src/context.ts";
export { MirrorStore } from "./src/store.ts";
export { publishMirrorAsset, mirrorComponentForAsset } from "./src/assets.ts";
export { mirrorFrameId } from "./src/protocol.ts";
export type { MirrorDelivery } from "./src/bridge.ts";

/**
 * Start the mirror channel: connect to the Pi's bridge, wire the voice
 * orchestrator into the turn pipeline, and register the mirror as a delivery
 * medium so every reply addressed to a `mirror:*` session is spoken and drawn.
 *
 * Returns null when the mirror is disabled or unconfigured — a host with no
 * glass attached simply has no mirror channel.
 */
export async function startMirrorRuntime(
  ctx: IntegrationRuntimeContext,
): Promise<IntegrationRuntime | null> {
  const config = ctx.config as Config;
  if (!mirrorConfig(config)?.enabled || !mirrorConfig(config).host) return null;
  if (!ctx.channel) {
    // The mirror cannot function as a tool-only plugin; failing loudly here
    // beats silently starting a bridge whose turns can never reach the model.
    log.error("mirror", "channel capabilities not granted — refusing to start");
    return null;
  }

  const { MirrorStore } = await import("./src/store.ts");
  const { MirrorBridge } = await import("./src/bridge.ts");
  const { MirrorOrchestrator } = await import("./src/orchestrator.ts");
  const { MirrorBackgroundWatch } = await import("./src/background-watch.ts");

  const store = new MirrorStore(config.paths.data_dir);

  // Two-phase init: the orchestrator needs the bridge to speak, the bridge
  // needs the orchestrator's handlers. Wire via a late-bound reference.
  let orchestrator: InstanceType<typeof MirrorOrchestrator> | null = null;
  const bridge = new MirrorBridge(config, store, {
    onWake: () => orchestrator?.onWake(),
    onUtterance: (wav, eventId) => void orchestrator?.onUtterance(wav, eventId),
    onAudioDone: (err, requestId, detail) => orchestrator?.onAudioDone(err, requestId, detail),
    onListenTimeout: () => orchestrator?.onListenTimeout(),
    onSpeakText: (text, requestId) =>
      orchestrator?.speak(text, "tool", requestId) ??
      Promise.resolve({ delivered: false, error: "mirror orchestrator unavailable" }),
    onCloseConversation: (requestId) => orchestrator?.closeConversation(`model tool ${requestId}`),
    onScreenStatus: (connected) => {
      orchestrator?.onScreenStatus(connected);
      log.info("mirror", `screen ${connected ? "connected" : "disconnected"}`);
    },
  });

  const sessionKey = mirrorConfig(config).session_key as SessionKey;
  orchestrator = new MirrorOrchestrator({
    config,
    // The pipeline is passed through the channel capability bundle; its
    // concrete type lives in core, so it is opaque to the host API.
    pipeline: ctx.channel.pipeline as never,
    bridge,
    store,
    interruptModel: (reason: string) => ctx.channel!.interruptTurn(sessionKey, reason),
  });

  // Live projection of the authoritative model/turn lifecycle onto the glass.
  ctx.channel.setLifecycle({
    onStarted: (turnId: string) => orchestrator!.onTurnStarted(turnId),
    onActivity: (turnId: string, phase: string, detail?: string) =>
      orchestrator!.onModelPhase(turnId, phase as never, detail),
    onTextDelta: (turnId: string, text: string) => orchestrator!.onModelTextDelta(turnId, text),
    onSettled: (turnId: string, outcome: string) =>
      orchestrator!.onTurnSettled(turnId, outcome as never),
  });

  // The mirror is a delivery medium like iMessage: voice turns, cron briefs,
  // and recovery fires addressed to a mirror:* chat id are all spoken.
  ctx.channel.setDeliverer((text, turnId) => orchestrator!.deliver(text, turnId));

  // Sub-agents are spawned inside an MCP subprocess, so the daemon only ever
  // learns about them from the agents table. Without this the dock folds the
  // moment the spawning turn ends and a running job vanishes from the glass.
  const backgroundWatch = new MirrorBackgroundWatch({
    dataDir: config.paths.data_dir,
    sessionKey,
    onWork: (jobs) => orchestrator?.onBackgroundWork(jobs),
  });
  backgroundWatch.start();
  bridge.start();
  log.info("mirror", "bridge starting", {
    endpoint: `ws://${mirrorConfig(config).host}:${mirrorConfig(config).port}`,
  });

  // Load the speech models now rather than on the first thing anyone says.
  // Deliberately not awaited: boot should not block on it, and every caller of
  // the sidecar already handles it not being ready yet.
  void import("./src/voice.ts").then(({ warmLocalSpeech }) =>
    warmLocalSpeech(config).catch(() => {}),
  );

  return {
    stop: async () => {
      bridge.stop();
      store.close();
      const { stopLocalTts } = await import("./src/voice.ts");
      stopLocalTts();
    },
  };
}
