// Push-to-talk speech input shared by the composer and Openrind Shell terminal.
// The renderer records microphone audio and sends it to the Electron main
// process, where ElevenLabs transcription runs without exposing the API key.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type VoiceStatus =
  | "unsupported"
  | "idle"
  | "recording"
  | "transcribing"
  | "error";

type UseVoiceInput = {
  status: VoiceStatus;
  error: string | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
};

function getDesktopInvoke() {
  if (typeof window === "undefined") return null;
  return window.__OPENRIND_DESKTOP_ELECTRON__?.invokeDesktop ?? null;
}

function detectSupport(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    navigator.mediaDevices &&
      typeof MediaRecorder !== "undefined" &&
      getDesktopInvoke(),
  );
}

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, "");
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
  useLayoutEffect(() => {
    onTranscriptRef.current = onTranscript;
    onErrorRef.current = onError;
  }, [onTranscript, onError]);

  const mountedRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestIdRef = useRef(0);
  const pendingIdRef = useRef<number | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const fail = useCallback((message: string) => {
    // eslint-disable-next-line no-console
    console.error("[voice]", message);
    pendingIdRef.current = null;
    if (!mountedRef.current) return;
    setError(message);
    setStatus("error");
    onErrorRef.current?.(message);
  }, []);

  const transcribe = useCallback(
    async (blob: Blob) => {
      if (blob.size === 0) {
        if (mountedRef.current) setStatus("idle");
        return;
      }

      const invokeDesktop = getDesktopInvoke();
      if (!invokeDesktop) {
        fail("ElevenLabs voice input is only available in the desktop app.");
        return;
      }

      const id = ++requestIdRef.current;
      pendingIdRef.current = id;
      try {
        const result = (await invokeDesktop("voiceTranscribe", {
          audio: await blob.arrayBuffer(),
          mimeType: blob.type || "audio/webm",
        })) as { text?: string };
        if (!mountedRef.current || pendingIdRef.current !== id) return;
        pendingIdRef.current = null;
        const text = (result?.text ?? "").trim();
        if (text) onTranscriptRef.current(text);
        setStatus("idle");
      } catch (transcriptionError) {
        if (pendingIdRef.current !== id) return;
        fail(readableError(transcriptionError));
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
        if (!mountedRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

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
      .catch((recordingError) => {
        stopStream();
        const denied =
          recordingError instanceof Error && recordingError.name === "NotAllowedError";
        fail(
          denied
            ? "Microphone access was denied."
            : readableError(recordingError),
        );
      });
  }, [fail, status, stopStream, supported]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (status !== "recording" || !recorder) return;
    setStatus("transcribing");
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || "audio/webm",
      });
      stopStream();
      void transcribe(blob);
    };
    recorder.stop();
  }, [status, stopStream, transcribe]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    pendingIdRef.current = null;
    requestIdRef.current += 1;
    stopStream();
    if (mountedRef.current) {
      setError(null);
      setStatus(supported ? "idle" : "unsupported");
    }
  }, [stopStream, supported]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      pendingIdRef.current = null;
      stopStream();
    };
  }, [stopStream]);

  return { status, error, start, stop, cancel };
}
