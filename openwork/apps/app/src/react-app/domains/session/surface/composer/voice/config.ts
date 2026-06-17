// On-device speech-to-text configuration and the message contract shared
// between the composer hook (use-voice-input.ts) and the Web Worker that runs
// Whisper (transcriber.worker.ts).
//
// Whisper runs entirely in the renderer via @huggingface/transformers — no
// microphone audio ever leaves the machine. Only the model weights are
// fetched (once) from the Hugging Face Hub, then cached locally.

// The Whisper checkpoint to load. `whisper-base` is the accuracy/size balance
// for dictating prompts (~140MB, multilingual). Swap to `Xenova/whisper-tiny.en`
// for the fastest/lightest English-only option, or `onnx-community/whisper-small`
// for higher accuracy at a larger download.
export const WHISPER_MODEL = "onnx-community/whisper-base";

// Whisper always operates on 16kHz mono PCM.
export const WHISPER_SAMPLE_RATE = 16000;

// --- Speech-to-text engine selection -------------------------------------

// Which engine the mic button uses. "whisper" runs on-device (default,
// private); "elevenlabs" sends audio to the ElevenLabs cloud API.
export type VoiceProvider = "whisper" | "elevenlabs";

// Mirrors PREFS_STORAGE_KEY in kernel/local-provider.tsx. Read directly here
// so the voice hook doesn't depend on the React Local context (which isn't
// mounted in every surface that renders the mic button, e.g. storybook).
const PREFS_STORAGE_KEY = "openwork.preferences";

export function getVoiceProvider(): VoiceProvider {
  if (typeof window === "undefined") return "whisper";
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return "whisper";
    const parsed = JSON.parse(raw) as { voiceProvider?: unknown };
    return parsed?.voiceProvider === "elevenlabs" ? "elevenlabs" : "whisper";
  } catch {
    return "whisper";
  }
}

// --- Worker message contract ---------------------------------------------

// Renderer → worker.
export type VoiceWorkerRequest =
  | { type: "transcribe"; id: number; audio: Float32Array; language?: string };

// Worker → renderer.
export type VoiceWorkerResponse =
  // First-run model download / warm-up progress (0..1, or null when unknown).
  | { type: "model-progress"; progress: number | null }
  // The pipeline is loaded and ready (subsequent requests skip the download).
  | { type: "model-ready" }
  // A finished transcription for the request with the matching id.
  | { type: "result"; id: number; text: string }
  // Something failed (model load or inference). id is present when tied to a request.
  | { type: "error"; id: number | null; message: string };
