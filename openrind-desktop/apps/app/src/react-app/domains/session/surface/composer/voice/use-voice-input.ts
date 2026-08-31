// React hook that owns the push-to-talk recording lifecycle for the composer
// and the Openrind Shell terminal: capture mic audio, send it to the ElevenLabs
// speech-to-text API via the desktop bridge, and surface the transcript via onTranscript.
// onError, when provided, is called with a human-readable string
// whenever recording/transcription fails, so callers can show it inline.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type VoiceStatus =
  | "unsupported"
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

export type UseVoiceInput = {
  status: VoiceStatus;
  error: string | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
};

function detectSupport(): boolean {
  if (typeof window === "undefined") return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return typeof MediaRecorder !== "undefined";
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

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  // Sync the latest callbacks synchronously after commit (before paint and
  // before any async message task), so a transcript result never runs an
  // older closure — which would otherwise append to a stale draft snapshot.
  useLayoutEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestIdRef = useRef(0);
  const pendingIdRef = useRef<number | null>(null);

  const fail = useCallback((message: string) => {
    // eslint-disable-next-line no-console
    console.error("[voice]", message);
    pendingIdRef.current = null;
    setError(message);
    setStatus("error");
    onErrorRef.current?.(message);
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // Send raw recording to the desktop main process (ElevenLabs)
  const transcribeAudio = useCallback(
    async (blob: Blob) => {
      const id = ++requestIdRef.current;
      pendingIdRef.current = id;
      try {
        const bridge = (
          window as unknown as {
            __OPENRIND_DESKTOP_ELECTRON__?: {
              invokeDesktop?: (command: string, ...args: unknown[]) => Promise<unknown>;
            };
          }
        ).__OPENRIND_DESKTOP_ELECTRON__;
        if (!bridge?.invokeDesktop) {
          throw new Error("Voice input is only available in the desktop app.");
        }
        const audio = await blob.arrayBuffer();
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
        if (pendingIdRef.current !== id) return; // superseded or cancelled
        pendingIdRef.current = null;
        const raw = err instanceof Error ? err.message : String(err);
        // Strip Electron's "Error invoking remote method '...': Error: " wrapper.
        fail(raw.replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, ""));
      }
    },
    [fail],
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
      void transcribeAudio(blob);
    };
    recorder.stop();
  }, [status, stopStream, transcribeAudio]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    pendingIdRef.current = null;
    stopStream();
    setStatus(supported ? "idle" : "unsupported");
  }, [stopStream, supported]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return { status, error, start, stop, cancel };
}
