/** @jsxImportSource react */
// Small dropdown shown next to the mic button indicating which speech-to-text
// engine is active (On-device Whisper vs ElevenLabs cloud) and letting the user
// switch. It reads/writes the same `voiceProvider` preference the Settings page
// uses, so the two stay in sync; the voice hook picks the change up on its next
// transcription via getVoiceProvider().

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useLocal } from "../../../../../kernel/local-provider";
import type { VoiceProvider } from "./config";

const ENGINE_OPTIONS: Array<{ value: VoiceProvider; label: string; hint: string }> = [
  { value: "whisper", label: "Whisper", hint: "On-device" },
  { value: "elevenlabs", label: "ElevenLabs", hint: "Cloud" },
];

type VoiceEngineMenuProps = {
  /** Which way the menu opens. Composer sits at the bottom of the screen → "up". */
  direction?: "up" | "down";
  /** Which edge the menu aligns to. */
  align?: "left" | "right";
};

export function VoiceEngineMenu(props: VoiceEngineMenuProps) {
  const local = useLocal();
  const provider = local.prefs.voiceProvider;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = ENGINE_OPTIONS.find((o) => o.value === provider) ?? ENGINE_OPTIONS[0];
  const vertical = props.direction === "up" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]";
  const horizontal = props.align === "left" ? "left-0" : "right-0";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
        onClick={() => setOpen((value) => !value)}
        onMouseDown={(e) => e.preventDefault()}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Voice engine: ${current.label} (${current.hint}). Click to change.`}
      >
        <span>{current.label}</span>
        <ChevronDown size={12} className={props.direction === "up" ? "rotate-180" : ""} />
      </button>
      {open ? (
        <div
          className={`absolute ${vertical} ${horizontal} z-30 w-52 rounded-2xl border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]`}
          role="menu"
        >
          {ENGINE_OPTIONS.map((option) => {
            const active = option.value === provider;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-gray-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  local.setPrefs((prev) => ({ ...prev, voiceProvider: option.value }));
                  setOpen(false);
                }}
              >
                <span className="flex flex-col">
                  <span className="text-sm text-gray-12">{option.label}</span>
                  <span className="text-[11px] text-gray-9">{option.hint}</span>
                </span>
                {active ? <Check size={15} className="shrink-0 text-dls-text" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
