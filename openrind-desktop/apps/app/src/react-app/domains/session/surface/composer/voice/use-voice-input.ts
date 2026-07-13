// React hook that owns the push-to-talk recording lifecycle for the composer
// and the Openrind Shell terminal: capture mic audio, decode it to 16kHz mono PCM,
// hand it to the Whisper worker, and surface the transcript via onTranscript.
// All audio stays on the device; only the worker (running Whisper locally)
// ever sees it. onError, when provided, is called with a human-readable string
// whenever recording/transcription fails, so callers can show it inline.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  WHISPER_SAMPLE_RATE,
  getVoiceProvider,
  type VoiceWorkerRequest,
  type VoiceWorkerResponse,
} from "./config";

export type VoiceStatus =
  | "unsupported"
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

type UseVoiceInput = {
  status: VoiceStatus;
  error: string | null;
  /** First-run model download progress (0..1), or null when not downloading. */
  modelProgress: number | null;
  /** True once the Whisper model has finished loading (subsequent runs skip the download). */
  modelReady: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
};

function detectSupport(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof Worker === "undefined") return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  return Boolean(AudioCtx && typeof MediaRecorder !== "undefined");
}

export function useVoiceInput(
  onTranscript: (text: string) => void,
  onError?: (message: string) => void,
): UseVoiceInput {
  const supported = detectSupport();
  const [status, setStatus] = useState<VoiceStatus>(
    supported ? "idle" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<number | null>(null);
  const [modelReady, setModelReady] = useState(false);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  // Sync the latest callbacks synchronously after commit (before paint and
  // before any worker-message task), so a transcript result never runs an
  // older closure — which would otherwise append to a stale draft snapshot.
  useLayoutEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestIdRef = useRef(0);
  const pendingIdRef = useRef<number | null>(null);

  const fail = useCallback((message: string) => {
    // eslint-disable-next-line no-console
    console.error("[voice]", message);
    pendingIdRef.current = null;
    setModelProgress(null);
    setError(message);
    setStatus("error");
    onErrorRef.current?.(message);
  }, []);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(
      new URL("./transcriber.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as VoiceWorkerResponse;
      switch (message.type) {
        case "model-progress":
          setModelProgress(message.progress);
          break;
        case "model-ready":
          setModelProgress(null);
          setModelReady(true);
          break;
        case "result":
          if (message.id !== pendingIdRef.current) return;
          pendingIdRef.current = null;
          setModelProgress(null);
          if (message.text) onTranscriptRef.current(message.text);
          setStatus("idle");
          break;
        case "error":
          if (message.id !== null && message.id !== pendingIdRef.current) return;
          fail(message.message);
          break;
      }
    };
    // Without this, a worker that fails to load or throws during model load
    // would leave the UI spinning forever with no clue why.
    worker.onerror = (event: ErrorEvent) => {
      fail(event.message || "Speech worker failed to load.");
    };
    worker.onmessageerror = () => {
      fail("Speech worker received an unreadable message.");
    };
    workerRef.current = worker;
    return worker;
  }, [fail]);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // On-device path: decode to 16kHz mono PCM and run Whisper in the worker.
  const transcribeWithWhisper = useCallback(
    async (blob: Blob) => {
      let ctx: AudioContext | null = null;
      try {
        const AudioCtx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        ctx = new AudioCtx({ sampleRate: WHISPER_SAMPLE_RATE });
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        // Mono: the mic is single-channel; channel 0 is all we need.
        const audio = new Float32Array(decoded.getChannelData(0));

        if (audio.length === 0) {
          setStatus("idle");
          return;
        }

        const id = ++requestIdRef.current;
        pendingIdRef.current = id;
        const request: VoiceWorkerRequest = { type: "transcribe", id, audio };
        // Transfer the PCM buffer instead of cloning it — `audio` is not used
        // after this, so handing ownership to the worker avoids copying the
        // full recording (which can be large for long-form dictation).
        ensureWorker().postMessage(request, [audio.buffer as ArrayBuffer]);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      } finally {
        // Always release the AudioContext, even when decodeAudioData rejects.
        if (ctx) {
          try {
            await ctx.close();
          } catch {
            /* already closed / closing — ignore */
          }
        }
      }
    },
    [ensureWorker, fail],
  );

  // Cloud path: hand the raw recording to the main process, which holds the
  // ElevenLabs key and performs the request (no decode/resample needed).
  const transcribeWithElevenLabs = useCallback(
    async (blob: Blob) => {
      try {
        const bridge = (
          window as unknown as {
            __OPENRIND_DESKTOP_ELECTRON__?: {
              invokeDesktop?: (command: string, ...args: unknown[]) => Promise<unknown>;
            };
          }
        ).__OPENRIND_DESKTOP_ELECTRON__;
        if (!bridge?.invokeDesktop) {
          throw new Error("ElevenLabs voice input is only available in the desktop app.");
        }
        const audio = await blob.arrayBuffer();
        const id = ++requestIdRef.current;
        pendingIdRef.current = id;
        const result = (await bridge.invokeDesktop("voiceTranscribe", {
          audio,
          mimeType: blob.type || "audio/webm",
        })) as { text?: string };
        if (pendingIdRef.current !== id) return; // superseded by a newer request
        pendingIdRef.current = null;
        const text = (result?.text ?? "").trim();
        if (text) onTranscriptRef.current(text);
        setStatus("idle");
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // Strip Electron's "Error invoking remote method '...': Error: " wrapper.
        fail(raw.replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, ""));
      }
    },
    [fail],
  );

  const transcribeBlob = useCallback(
    (blob: Blob) =>
      getVoiceProvider() === "elevenlabs"
        ? transcribeWithElevenLabs(blob)
        : transcribeWithWhisper(blob),
    [transcribeWithElevenLabs, transcribeWithWhisper],
  );

  const start = useCallback(() => {
    if (!supported || status === "recording" || status === "transcribing") return;
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        chunksRef.current = [];
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorderRef.current = recorder;
        recorder.start();
        setStatus("recording");
      })
      .catch((err) => {
        stopStream();
        // NotAllowedError → user/OS denied the mic.
        const denied = err instanceof Error && err.name === "NotAllowedError";
        fail(denied ? "Microphone access was denied." : String(err));
      });
  }, [fail, status, stopStream, supported]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (status !== "recording" || !recorder) return;
    setStatus("transcribing");
    recorder.onstop = () => {
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      stopStream();
      void transcribeBlob(blob);
    };
    recorder.stop();
  }, [status, stopStream, transcribeBlob]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    pendingIdRef.current = null;
    stopStream();
    setModelProgress(null);
    setStatus(supported ? "idle" : "unsupported");
  }, [stopStream, supported]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return { status, error, modelProgress, modelReady, start, stop, cancel };
}
