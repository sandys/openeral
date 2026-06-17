// React hook that owns the push-to-talk recording lifecycle for the composer
// and the OpenEral terminal: capture mic audio, decode it to 16kHz mono PCM,
// hand it to the Whisper worker, and surface the transcript via onTranscript.
// All audio stays on the device; only the worker (running Whisper locally)
// ever sees it. onError, when provided, is called with a human-readable string
// whenever recording/transcription fails, so callers can show it inline.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  WHISPER_SAMPLE_RATE,
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
  useEffect(() => {
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

  const transcribeBlob = useCallback(
    async (blob: Blob) => {
      try {
        const AudioCtx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new AudioCtx({ sampleRate: WHISPER_SAMPLE_RATE });
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        // Mono: the mic is single-channel; channel 0 is all we need.
        const audio = new Float32Array(decoded.getChannelData(0));
        void ctx.close();

        if (audio.length === 0) {
          setStatus("idle");
          return;
        }

        const id = ++requestIdRef.current;
        pendingIdRef.current = id;
        const request: VoiceWorkerRequest = { type: "transcribe", id, audio };
        // A few seconds of 16kHz PCM is small, so a structured-clone copy is fine.
        ensureWorker().postMessage(request);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
    [ensureWorker, fail],
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
