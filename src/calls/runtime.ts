/**
 * Assembles the call system for the daemon: the providers (FaceTime, and the
 * voice lab when it is on), Edmund's voice, the policy, the takeover, and the
 * manager that holds them together. main.ts hands over the few daemon
 * capabilities a call needs and gets back something to stop; nothing else in
 * main knows calls exist.
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
import { operatorHandles } from "../security/policy.ts";
import type { ContactBook } from "../sessions/contacts.ts";
import type { SessionKey } from "../sessions/key.ts";
import { log } from "../util/log.ts";
import { SpeechSidecar, defaultPython, kokoroVoices } from "../voice/speech-sidecar.ts";
import { Transcriber } from "../voice/transcriber.ts";
import { TurnDetector } from "../voice/turn-detector.ts";
import { type SessionRecords, conversationForPeer, ensureSessionFor } from "./conversation.ts";
import { CallManager } from "./manager.ts";
import { CallPolicy } from "./policy.ts";
import { FaceTimeProvider } from "./providers/facetime/provider.ts";
import { LAB_PROVIDER, WebProvider } from "./providers/web/provider.ts";
import { LabServer } from "./providers/web/server.ts";
import { CallStore } from "./store.ts";
import { clearForCall } from "./takeover.ts";
import type { CallProvider, Speaker } from "./types.ts";
import { routeVoice } from "./voice-router.ts";
import {
  VoiceSettingsStore,
  engineOf,
  phononName,
  phononVoice,
  voiceForCall,
} from "./voice-settings.ts";

/** Kokoro and Phonon both synthesise at 24 kHz; the mouth is opened at the same rate. */
const SAMPLE_RATE = 24_000;
/**
 * How long after the last call (or the last thing heard) the transcriber
 * stays loaded: long enough for "call me back", short enough that its
 * 1.5 GB is not held all day for a few minutes of calls.
 */
const HEARING_IDLE_UNLOAD_MS = 10 * 60_000;
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
  /** Session records, so a call to someone never texted still has a conversation to wake. */
  state: SessionRecords;
  activeSessions: Set<SessionKey>;
  turnControllers: Map<SessionKey, AbortController>;
};

export type CallRuntime = { stop: () => Promise<void> };

function nativeBuild(): { dylib: string; audioApp: string; mouth: string; turnModel: string } {
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
    // Smart Turn v3.2 (pipecat-ai/smart-turn-v3), fetched at a pinned hash.
    turnModel: join(root, "smart-turn-v3.2-cpu.onnx"),
  };
}

export async function startCallRuntime(deps: CallRuntimeDeps): Promise<CallRuntime | null> {
  const { config } = deps;
  const settings = config.facetime;
  const labOn = config.voice_lab.enabled;
  if (!settings.enabled && !labOn) return null;

  const native = nativeBuild();
  let faceTimeOn = settings.enabled;
  const missing = [native.dylib, native.audioApp, native.mouth].filter((path) => !existsSync(path));
  if (faceTimeOn && missing.length > 0) {
    log.error(
      "calls",
      "FaceTime is enabled but its native pieces are not built (make -C native/facetime)",
      {
        missing: missing.join(", "),
      },
    );
    if (!labOn) return null;
    faceTimeOn = false;
  }

  const dataDir = config.paths.data_dir;
  // As tuned in the voice lab; read at every sentence, so a change is heard
  // from the next one on.
  const kokoroVoice = settings.kokoro_voice || DEFAULT_VOICE;
  const voiceSettings = new VoiceSettingsStore(join(dataDir, "calls", "voice.json"), {
    voice: kokoroVoice,
    speed: 1,
  });
  const tunedEngine = () => engineOf(voiceSettings.get().voice);
  // A process for each engine, and neither is the mirror's, so a call never
  // waits behind it. The one whose voice is in use is resident: an idle
  // unload or a mid-call recycle is a pause the caller hears. The other loads
  // when it is asked for (a preview in the lab, a line Phonon could not say)
  // and gives its memory back when left alone.
  const kokoro = new SpeechSidecar({
    voice: kokoroVoice,
    sttModel: "",
    tag: "facetime",
    resident: () => tunedEngine() === "kokoro",
    pronounce: join(dataDir, "calls", "pronounce.json"),
  });
  const tunedAtBoot = voiceSettings.get().voice;
  const phonon = new SpeechSidecar({
    engine: "phonon",
    // Spoken once as it loads, so the voice is in its cache before a call is.
    voice: engineOf(tunedAtBoot) === "phonon" ? phononName(tunedAtBoot) : "",
    sttModel: "",
    tag: "facetime",
    resident: () => tunedEngine() === "phonon",
  });
  const say = routeVoice({
    phonon: (text, voice, speed) => phonon.synthesize(text, voice, speed),
    kokoro: (text, voice, speed) => kokoro.synthesize(text, voice, speed),
    fallbackVoice: kokoroVoice,
    warn: (message, fields) => log.warn("calls", message, fields),
  });
  const warmVoice = () => void (tunedEngine() === "phonon" ? phonon : kokoro).warmup();
  const store = new CallStore(dataDir);
  let manager: CallManager | null = null;
  // The voice Edmund chose for this call (call_voice) is checked here, where
  // it is used, against the rule and the voices Kokoro has: the tool's own
  // check runs in another process. Read from Kokoro's voices file once, when
  // first needed, without starting Kokoro to ask.
  let installed: string[] | null = null;
  const speaker: Speaker = {
    synthesize: async (text) => {
      const tuned = voiceSettings.get();
      const call = manager?.current();
      const chosen = call ? store.voice(call.id) : null;
      if (chosen) installed ??= kokoroVoices();
      const { voice, speed } = voiceForCall(tuned, chosen, installed);
      if (chosen && voice !== chosen)
        log.warn("calls", "chosen voice refused", { chosen, voice, installed: installed !== null });
      const audio = await say(text, voice, speed);
      return audio ? { pcm: audio.pcm, sampleRate: audio.sampleRate } : null;
    },
    warm: warmVoice,
    // As synthesize chooses it: the call's own voice if Edmund picked one.
    voiceKey: () => {
      const tuned = voiceSettings.get();
      const call = manager?.current();
      const chosen = call ? store.voice(call.id) : null;
      const { voice, speed } = voiceForCall(tuned, chosen, installed);
      return `${voice}@${speed}`;
    },
  };
  warmVoice();
  // Resident for as long as calls are on: ~9 MB, and a verdict is ~12 ms.
  // Without the model (make -C native/facetime turn-model) every pause falls
  // back to the fixed silence timer.
  const turnDetector = new TurnDetector({ python: defaultPython(), model: native.turnModel });
  if (turnDetector.installed()) turnDetector.start();
  else
    log.warn("calls", "turn detection off: no model or python", {
      model: native.turnModel,
      hint: "make -C native/facetime turn-model",
    });

  // Both kinds of call hear with the Ear: Parakeet on each stretch of speech.
  // Loaded now, so a broken install is known at boot and not on the first
  // call; then again at each ring (CallManager.prepareToHear), and let go
  // once no call has needed it for a while. Never during one.
  const transcriber = new Transcriber({
    python: defaultPython(),
    idleUnloadMs: HEARING_IDLE_UNLOAD_MS,
    inUse: () => manager?.current() != null,
  });
  if (!transcriber.installed()) {
    log.error("calls", "calls are off: no transcriber python (scripts/install-kokoro.sh)", {
      python: defaultPython(),
    });
    return null;
  }
  void transcriber.start();
  const turnVerdict = async (pcm: string) =>
    turnDetector.installed() ? ((await turnDetector.verdict(pcm))?.probability ?? null) : null;

  const agents = new AgentStore(dataDir);
  const faceTime = faceTimeOn
    ? new FaceTimeProvider({
        dylibPath: native.dylib,
        audioAppPath: native.audioApp,
        audioSocketPath: join(dataDir, "run", "facetime", "audio.sock"),
        mouthPath: native.mouth,
        mouthSocketPath: join(dataDir, "run", "facetime", "mouth.sock"),
        mouthDevice: settings.mouth_device,
        micDevice: settings.mic_device,
        sampleRate: SAMPLE_RATE,
        callAudioProcesses: settings.call_audio_processes,
        transcribe: (pcm) => transcriber.transcribe(pcm),
        turnVerdict,
        ...(settings.keep_turn_clips
          ? { turnClipDir: join(dataDir, "run", "facetime", "turn-clips") }
          : {}),
      })
    : null;

  const lab = labOn
    ? new WebProvider({
        peer: () => {
          const handle = operatorHandles(config)[0];
          return handle ? { kind: "person", handle } : null;
        },
        transcribe: (pcm) => transcriber.transcribe(pcm),
        turnVerdict,
        busy: () => {
          const call = manager?.current();
          return call ? `Edmund is on a ${call.provider} call` : null;
        },
        ringTimeoutMs: settings.ring_answer_ms + 10_000,
      })
    : null;
  const providers: CallProvider[] = [faceTime, lab].filter(
    (p): p is NonNullable<typeof p> => p !== null,
  );

  manager = new CallManager({
    settings: {
      maxCallMinutes: settings.max_call_minutes,
      ringAnswerMs: settings.ring_answer_ms,
      endpointMs: settings.endpoint_ms,
      // After the route is verified. OpenClaw settles 100 ms on the same signal.
      connectSettleMs: 200,
      // Smart Turn's own decision threshold; a complete turn ends once its
      // transcript lands, an incomplete one after 0.8 s more of quiet.
      turnThreshold: 0.5,
      turnCompleteGraceMs: 80,
      turnIncompleteWaitMs: 800,
      // From the transcript's arrival, about 0.4 s after they stopped.
      turnPunctuatedWaitMs: 250,
      hesitationHoldMs: 4_000,
      holdReleaseMs: 1_500,
      dialTimeoutMs: 45_000,
      pollMs: 300,
      openerLine: settings.opener.trim(),
      // Long enough for a line that is being synthesised to land first; short
      // enough that "hello?" still comes before they say it twice.
      openerGraceMs: 1_200,
      thinkingSounds: settings.thinking_sounds.map((sound) => sound.trim()).filter(Boolean),
      thinkingAfterMs: settings.thinking_sound_after_ms,
      quietCheckMs: settings.quiet_check_seconds * 1000,
    },
    provider: providers[0]!,
    inboundProviders: providers.slice(1),
    store,
    speaker,
    prepareToHear: () => void transcriber.start(),
    conversationFor: (peer) =>
      conversationForPeer(peer, { chatDb: deps.chatDb, contacts: deps.contacts }),
    ensureConversation: (conversation) => ensureSessionFor(conversation, deps.state),
    policy: new CallPolicy(config, deps.contacts),
    canon: (handle) => deps.contacts.canon(handle),
    routeInbound: deps.deliverToSession,
    fireSystemEvent: deps.fireSystemEvent,
    expediteWakeUps: deps.expediteWakeUps,
    clearForCall: (sessionKey, label, deadlineMs) => {
      // The ring is the cue to load the voice, while nobody is waiting yet.
      warmVoice();
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
    companions: lab
      ? [
          {
            name: "voice lab transcript",
            onUtterance: (call, utterance) => {
              if (call.provider === LAB_PROVIDER) lab.tell({ type: "utterance", ...utterance });
            },
          },
        ]
      : [],
    onExchange: (call, fields) => {
      if (call.provider === LAB_PROVIDER) lab?.tell({ type: "exchange", fields });
    },
    alert: deps.alert,
  });

  await manager.start();
  log.info("calls", "calls enabled", {
    providers: providers.map((p) => p.name).join(", "),
    allow: settings.allow.length,
    deny: settings.deny.length,
  });

  let labServer: LabServer | null = null;
  if (lab) {
    labServer = new LabServer({
      port: config.voice_lab.port,
      hostname: config.voice_lab.host,
      dir: join(dataDir, "secrets", "voice-lab"),
      provider: lab,
      settings: voiceSettings,
      // Phonon's catalog first, then Kokoro's voices read from their file:
      // listing them starts neither model that is not already running.
      voices: async () => [...((await phonon.voices()) ?? []).map(phononVoice), ...kokoroVoices()],
      synthesize: async (text, voice, speed) => {
        const audio = await say(text, voice, speed);
        return audio ? { pcm: audio.pcm, sampleRate: audio.sampleRate } : null;
      },
    });
    try {
      labServer.start();
    } catch (err) {
      log.error("voice-lab", "could not start", { err: (err as Error).message });
      labServer = null;
    }
  }

  const running = manager;
  return {
    stop: async () => {
      labServer?.stop();
      await running.stop();
      kokoro.stop();
      phonon.stop();
      transcriber?.stop();
      turnDetector.stop();
      store.close();
      agents.close();
    },
  };
}
