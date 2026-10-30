import type { Config } from "../../../src/config/config.ts";
import { SpeechSidecar as SharedSidecar } from "../../../src/voice/speech-sidecar.ts";
import { mirrorConfig } from "../config.ts";

export type { KokoroAudio } from "../../../src/voice/speech-sidecar.ts";

/**
 * The mirror's own speech sidecar: the shared Kokoro + Whisper process
 * (src/voice/speech-sidecar.ts), configured from [mirror]. FaceTime calls run
 * a separate one, so the mirror never waits behind a call.
 */
export class SpeechSidecar extends SharedSidecar {
  constructor(config: Config, idleUnloadMs?: number) {
    const mirror = mirrorConfig(config);
    super(
      {
        python: mirror.kokoro_python,
        model: mirror.kokoro_model,
        voices: mirror.kokoro_voices,
        voice: mirror.kokoro_voice,
        sttModel: mirror.local_stt_model,
        tag: "mirror",
      },
      idleUnloadMs,
    );
  }
}
