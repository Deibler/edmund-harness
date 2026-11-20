/**
 * Which engine says a sentence, and what happens when it cannot.
 *
 * Phonon speaks a "phonon:Name" voice. When it has nothing to give (the
 * process is down, the voice is not in its cache and there is no network,
 * the model ran on twice), Kokoro says that sentence in its own voice: a
 * caller hearing a different voice for a line is better off than one hearing
 * nothing. Kokoro's voices go to Kokoro alone; it has no understudy.
 */

import { engineOf, phononName } from "./voice-settings.ts";

export type Audio = { pcm: Uint8Array; sampleRate: number };
export type Synth = (text: string, voice: string, speed: number) => Promise<Audio | null>;

export type VoiceRouterDeps = {
  /** Phonon, given a catalog name ("Micah"). */
  phonon: Synth;
  /** Kokoro, given a voice or a blend. */
  kokoro: Synth;
  /** The Kokoro voice that stands in for a Phonon one. */
  fallbackVoice: string;
  warn: (message: string, fields: Record<string, unknown>) => void;
};

export function routeVoice(deps: VoiceRouterDeps): Synth {
  return async (text, voice, speed) => {
    if (engineOf(voice) === "kokoro") return deps.kokoro(text, voice, speed);
    const audio = await deps.phonon(text, phononName(voice), speed);
    if (audio) return audio;
    deps.warn("phonon could not say a line; kokoro says it", {
      voice,
      fallback: deps.fallbackVoice,
      chars: text.length,
    });
    return deps.kokoro(text, deps.fallbackVoice, speed);
  };
}
