// Composer toolbar button for voice dictation. Press to record,
// press again to stop; the transcript is delivered via onTranscript and the
// composer appends it to the prompt draft. Renders nothing when the runtime
// can't support recording/transcription (e.g. no mic API).

import { Loader2, Mic, Square } from "lucide-react";
import { useVoiceInput } from "./use-voice-input";

type MicButtonProps = {
  onTranscript: (text: string) => void;
  disabled?: boolean;
};

const BASE_CLASS =
  "inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-md transition-colors";

export function MicButton(props: MicButtonProps) {
  const { status, error, start, stop } = useVoiceInput(
    props.onTranscript,
  );

  if (status === "unsupported") return null;

  const recording = status === "recording";
  const transcribing = status === "transcribing";
  const busy = transcribing;

  let title = "Dictate with your voice";
  if (recording) title = "Stop recording";
  else if (transcribing) {
    title = "Transcribing…";
  } else if (status === "error" && error) {
    title = `${error} — click to try again`;
  }

  const handleClick = () => {
    if (props.disabled || busy) return;
    if (recording) stop();
    else start();
  };

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={props.disabled || busy}
        aria-label={title}
        aria-pressed={recording}
        title={title}
        className={`${BASE_CLASS} ${
          recording
            ? "bg-gray-3 text-[#e5484d]"
            : busy
              ? "cursor-default text-gray-10"
              : "text-gray-10 hover:bg-gray-3"
        } ${props.disabled ? "cursor-not-allowed opacity-60" : ""}`}
      >
        {transcribing ? (
          <Loader2 size={16} className="animate-spin" />
        ) : recording ? (
          <Square size={14} fill="currentColor" className="animate-pulse" />
        ) : (
          <Mic size={16} />
        )}
      </button>
    </div>
  );
}
