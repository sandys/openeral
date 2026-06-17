// Web Worker that runs Whisper speech-to-text on-device via Transformers.js.
//
// Kept off the main thread because model load + inference are CPU/GPU heavy and
// would otherwise jank the UI. The worker lazily loads a single pipeline on the
// first request and reuses it for the rest of the session.
//
// NOTE: This file is type-checked against the app's DOM lib (no "webworker"
// lib), so we deliberately use the DOM-compatible `self.onmessage` /
// `self.postMessage(msg)` shapes, which are valid in both a Window and a
// DedicatedWorkerGlobalScope at runtime.

import { pipeline, env } from "@huggingface/transformers";
import {
  WHISPER_MODEL,
  type VoiceWorkerRequest,
  type VoiceWorkerResponse,
} from "./config";
import { indexedDbModelCache } from "./idb-cache";

// Persist downloaded model weights in IndexedDB so they download once and then
// work offline — including under Electron's file:// origin, where the Cache
// Storage API that Transformers.js uses by default doesn't persist.
if (typeof indexedDB !== "undefined") {
  env.useCustomCache = true;
  env.customCache = indexedDbModelCache;
}

type Transcriber = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text: string } | Array<{ text: string }>>;

function post(message: VoiceWorkerResponse): void {
  self.postMessage(message);
}

// Use WebGPU only if an adapter is actually available — `navigator.gpu` can
// exist while requestAdapter() returns null (no usable GPU), and committing to
// WebGPU in that case makes model load hang. Otherwise fall back to WASM.
async function pickDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const gpu = (navigator as unknown as {
      gpu?: { requestAdapter?: () => Promise<unknown> };
    }).gpu;
    if (gpu?.requestAdapter) {
      const adapter = await gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {
    // fall through to wasm
  }
  return "wasm";
}

let transcriberPromise: Promise<Transcriber> | null = null;

function getTranscriber(): Promise<Transcriber> {
  if (transcriberPromise) return transcriberPromise;
  transcriberPromise = (async () => {
    const device = await pickDevice();
    if (device === "wasm" && env.backends?.onnx?.wasm) {
      // Without cross-origin isolation (COOP/COEP) SharedArrayBuffer is absent,
      // so pin to a single thread to avoid noisy fallbacks.
      env.backends.onnx.wasm.numThreads = 1;
    }
    // WebGPU: full-precision encoder + 4-bit decoder (the proven whisper-webgpu
    // recipe — small + fast). WASM: 8-bit everything (~50MB, broadly compatible).
    const dtype =
      device === "webgpu"
        ? ({ encoder_model: "fp32", decoder_model_merged: "q4" } as const)
        : ("q8" as const);
    // eslint-disable-next-line no-console
    console.log(`[voice] loading ${WHISPER_MODEL} on ${device} (dtype=${JSON.stringify(dtype)})`);
    // Aggregate per-file download progress into one overall fraction so the
    // UI shows a single smooth 0→100% instead of each file restarting at 0.
    const fileProgress = new Map<string, { loaded: number; total: number }>();
    const t = await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
      device,
      dtype,
      progress_callback: (item: unknown) => {
        const p = item as {
          status?: string;
          file?: string;
          loaded?: number;
          total?: number;
        };
        if (
          p?.status === "progress" &&
          p.file &&
          typeof p.loaded === "number" &&
          typeof p.total === "number"
        ) {
          fileProgress.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0;
          let total = 0;
          for (const v of fileProgress.values()) {
            loaded += v.loaded;
            total += v.total;
          }
          if (total > 0) post({ type: "model-progress", progress: loaded / total });
        }
      },
    });
    // eslint-disable-next-line no-console
    console.log("[voice] model ready");
    post({ type: "model-ready" });
    return t as unknown as Transcriber;
  })().catch((err) => {
    // Reset so a later request can retry from scratch.
    transcriberPromise = null;
    throw err;
  });
  return transcriberPromise;
}

self.onmessage = async (event: MessageEvent) => {
  const request = event.data as VoiceWorkerRequest;
  if (request?.type !== "transcribe") return;

  const { id, audio, language } = request;
  try {
    const transcriber = await getTranscriber();
    const output = await transcriber(audio, {
      // Long-form support so dictation longer than 30s still transcribes.
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(language ? { language } : {}),
    });
    const text = Array.isArray(output)
      ? output.map((chunk) => chunk.text).join(" ")
      : output.text;
    post({ type: "result", id, text: (text ?? "").trim() });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[voice] transcription failed:", err);
    post({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
