/**
 * Edmund's call voice, as tuned in the voice lab: which voice and how fast.
 * A voice is Kokoro's ("bm_daniel", or a blend of several) or one from
 * Phonon's catalog ("phonon:Micah"); the name says which engine speaks it.
 * Every call reads it at each sentence, so a change is heard from the next
 * sentence on, on FaceTime as in the lab.
 *
 * A file in the data dir rather than config.toml: the lab writes it, and a
 * program rewriting the operator's hand-edited config is how comments and
 * settings get lost. Absent, the voice is the configured default.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../util/log.ts";

export type VoiceSettings = {
  /**
   * A Kokoro voice ("bm_daniel"), a blend of them
   * ("bm_daniel:0.7,am_michael:0.3"), or a Phonon voice ("phonon:Micah").
   */
  voice: string;
  /** How fast, 0.5-2.0: 1 is the voice's own pace. */
  speed: number;
};

const NAME = "[a-z]{2}_[a-z]+";
const WEIGHT = "(?::(?:\\d+(?:\\.\\d+)?|\\.\\d+))?";
const KOKORO = new RegExp(`^${NAME}${WEIGHT}(?:,${NAME}${WEIGHT})*$`);
/** Phonon's catalog names are people's and characters': "Micah", "Elodie-Rose", "Old Mortlake". */
const PHONON_PREFIX = "phonon:";
const PHONON = /^phonon:\p{L}[\p{L} '-]*$/u;

export type VoiceEngine = "kokoro" | "phonon";

/** Which engine speaks a voice. */
export function engineOf(voice: string): VoiceEngine {
  return voice.startsWith(PHONON_PREFIX) ? "phonon" : "kokoro";
}

/** A Phonon catalog name as a voice setting, and back. */
export function phononVoice(name: string): string {
  return `${PHONON_PREFIX}${name}`;
}
export function phononName(voice: string): string {
  return voice.slice(PHONON_PREFIX.length);
}

/** The voice names a setting uses: a blend's parts, or the one Phonon voice. */
export function voiceNames(voice: string): string[] {
  if (engineOf(voice) === "phonon") return [voice];
  return voice.split(",").map((part) => part.split(":")[0]!);
}

/** Settings as given, or why not. */
export function validVoiceSettings(
  value: unknown,
): { ok: true; settings: VoiceSettings } | { ok: false; error: string } {
  const v = value as Partial<VoiceSettings> | null;
  if (!v || typeof v.voice !== "string" || !(KOKORO.test(v.voice) || PHONON.test(v.voice)))
    return {
      ok: false,
      error:
        "voice must be a Kokoro voice name, a blend like a_b:0.7,c_d:0.3, or a Phonon voice like phonon:Micah",
    };
  if (typeof v.speed !== "number" || !(v.speed >= 0.5 && v.speed <= 2))
    return { ok: false, error: "speed must be between 0.5 and 2" };
  return { ok: true, settings: { voice: v.voice, speed: Math.round(v.speed * 100) / 100 } };
}

/**
 * The voices Edmund may choose for himself on a call: male American and
 * British only (the operator's choice, 2026-10-30). Kokoro names a voice by language, then
 * gender, so "am_" is American male and "bm_" British male.
 */
const OWN_VOICE = /^[ab]m_[a-z]+$/;

export function ownVoices(installed: readonly string[]): string[] {
  return installed.filter((name) => OWN_VOICE.test(name));
}

/**
 * The voice for the next sentence of a call: the one Edmund chose for it, if
 * that is one he may use and Kokoro has it, else the tuned one. Speed is
 * always the lab's.
 */
export function voiceForCall(
  tuned: VoiceSettings,
  chosen: string | null,
  installed: readonly string[] | null,
): VoiceSettings {
  if (chosen && installed && ownVoices(installed).includes(chosen))
    return { ...tuned, voice: chosen };
  return tuned;
}

/**
 * Read from disk every time: a 50-byte file once per sentence costs nothing,
 * and a cache keyed on the file's clock served a stale voice after two saves
 * in the same millisecond.
 */
export class VoiceSettingsStore {
  constructor(
    private readonly path: string,
    private readonly defaults: VoiceSettings,
  ) {}

  get(): VoiceSettings {
    if (!existsSync(this.path)) return this.defaults;
    try {
      const parsed = validVoiceSettings(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.ok) {
        log.warn("calls", "voice settings ignored", { path: this.path, error: parsed.error });
        return this.defaults;
      }
      return parsed.settings;
    } catch (err) {
      log.warn("calls", "voice settings unreadable", { err: (err as Error).message });
      return this.defaults;
    }
  }

  set(settings: VoiceSettings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
