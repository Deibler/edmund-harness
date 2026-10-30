/**
 * Assembles the call system for the daemon: the FaceTime provider, Edmund's
 * voice, the policy, the takeover, and the manager that holds them together.
 * main.ts hands over the few daemon capabilities a call needs and gets back
 * something to stop; nothing else in main knows calls exist.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../agents/spawn.ts";
import { AgentStore } from "../agents/store.ts";
import { inFlightRequest } from "../channels/turn.ts";
import { injectIntoRunningTurn } from "../claude/runner.ts";
import type { Config } from "../config/config.ts";
import type { ChatDb } from "../imessage/db.ts";
import type { InboundMessage } from "../imessage/types.ts";
import { ensureSandbox } from "../persona/sandbox.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { SpeechSidecar } from "../voice/speech-sidecar.ts";
import { conversationForPeer } from "./conversation.ts";
import { CallManager } from "./manager.ts";
import { CallPolicy } from "./policy.ts";
import { FaceTimeProvider } from "./providers/facetime/provider.ts";
import { CallStore } from "./store.ts";
import { clearForCall } from "./takeover.ts";
import type { Speaker } from "./types.ts";

/** Kokoro synthesises at 24 kHz; the mouth is opened at the same rate. */
const SAMPLE_RATE = 24_000;
/** Edmund's voice on the mirror too (Kokoro's British male), so he sounds the same everywhere. */
const DEFAULT_VOICE = "bm_daniel";

export type CallRuntimeDeps = {
  config: Config;
  chatDb: ChatDb;
  contacts: ContactBook;
  /** Deliver a message into a session exactly as an arriving text would be. */
  deliverToSession: (sessionKey: SessionKey, msg: InboundMessage) => void;
  fireSystemEvent: (sessionKey: SessionKey, text: string) => void;
  /** Fire the session's pending agent-completion wake-ups now (see CallManagerDeps). */
  expediteWakeUps: (sessionKey: SessionKey) => void;
  alert: (message: string) => void;
  activeSessions: Set<SessionKey>;
  turnControllers: Map<SessionKey, AbortController>;
};

export type CallRuntime = { stop: () => Promise<void> };

function nativeBuild(): { dylib: string; audioApp: string; mouth: string } {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "native",
    "facetime",
    "build",
  );
  return {
    dylib: join(root, "FaceTimeControl.dylib"),
    audioApp: join(root, "EdmundCallAudio.app"),
    mouth: join(root, "EdmundMouth"),
  };
}

export async function startCallRuntime(deps: CallRuntimeDeps): Promise<CallRuntime | null> {
  const { config } = deps;
  const settings = config.facetime;
  if (!settings.enabled) return null;

  const native = nativeBuild();
  const missing = [native.dylib, native.audioApp, native.mouth].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    log.error(
      "calls",
      "FaceTime is enabled but its native pieces are not built (make -C native/facetime)",
      {
        missing: missing.join(", "),
      },
    );
    return null;
  }

  const dataDir = config.paths.data_dir;
  // Its own process: a call never waits behind the mirror, and recognition is
  // Apple's on the helper side, so Whisper never loads here.
  const sidecar = new SpeechSidecar({
    voice: settings.kokoro_voice || DEFAULT_VOICE,
    sttModel: "",
    tag: "facetime",
  });
  const speaker: Speaker = {
    synthesize: async (text) => {
      const audio = await sidecar.synthesize(text);
      return audio ? { pcm: audio.pcm, sampleRate: audio.sampleRate } : null;
    },
  };

  const store = new CallStore(dataDir);
  const agents = new AgentStore(dataDir);
  const provider = new FaceTimeProvider({
    dylibPath: native.dylib,
    audioAppPath: native.audioApp,
    audioSocketPath: join(dataDir, "facetime", "audio.sock"),
    mouthPath: native.mouth,
    mouthSocketPath: join(dataDir, "facetime", "mouth.sock"),
    mouthDevice: settings.mouth_device,
    micDevice: settings.mic_device,
    sampleRate: SAMPLE_RATE,
    callAudioProcesses: settings.call_audio_processes,
    locale: settings.locale,
  });

  const manager = new CallManager({
    settings: {
      maxCallMinutes: settings.max_call_minutes,
      ringAnswerMs: settings.ring_answer_ms,
      endpointMs: settings.endpoint_ms,
      // After the route is verified. OpenClaw settles 100 ms on the same signal.
      connectSettleMs: 200,
      dialTimeoutMs: 45_000,
      pollMs: 300,
    },
    provider,
    store,
    speaker,
    conversationFor: (peer) =>
      conversationForPeer(peer, { chatDb: deps.chatDb, contacts: deps.contacts }),
    policy: new CallPolicy(config, deps.contacts),
    canon: (handle) => deps.contacts.canon(handle),
    routeInbound: deps.deliverToSession,
    fireSystemEvent: deps.fireSystemEvent,
    expediteWakeUps: deps.expediteWakeUps,
    clearForCall: (sessionKey, label, deadlineMs) => {
      // The ring is the cue to load the voice, while nobody is waiting yet.
      void sidecar.warmup();
      return clearForCall(
        {
          isBusy: (key) => deps.activeSessions.has(key),
          inject: (key, text) => injectIntoRunningTurn(key, text).ok,
          interrupt: (key, reason) => {
            const controller = deps.turnControllers.get(key);
            if (!controller || controller.signal.aborted) return false;
            controller.abort(reason);
            return true;
          },
          inFlightRequest,
          spawnHandoff: (key, task) =>
            spawnAgent(agents, dataDir, ensureSandbox(key, null), {
              parentSessionKey: key,
              task,
              role: "handoff",
            }).id,
          agentsSince: (key, sinceMs) =>
            agents
              .list({ parentSessionKey: key })
              .filter((agent) => agent.spawnedAt >= sinceMs)
              .map((agent) => agent.id),
          now: Date.now,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        sessionKey,
        label,
        deadlineMs,
      );
    },
    companions: [],
    alert: deps.alert,
  });

  await manager.start();
  log.info("calls", "FaceTime calls enabled", {
    allow: settings.allow.length,
    deny: settings.deny.length,
  });

  return {
    stop: async () => {
      await manager.stop();
      sidecar.stop();
      store.close();
      agents.close();
    },
  };
}
