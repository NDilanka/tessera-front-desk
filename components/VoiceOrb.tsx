"use client";

import type { AgentState } from "@/lib/types-client";

const GLYPH: Record<AgentState, string> = {
  idle: "🎙️",
  listening: "●",
  thinking: "…",
  speaking: "🔊",
};

const LABEL: Record<AgentState, string> = {
  idle: "Tap to talk",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Tap to stop",
};

/**
 * The single focal control: a state-colored orb. Tapping it drives the whole
 * half-duplex flow — start listening from idle, or cancel speech (→ listening)
 * while speaking. Disabled during `thinking` (nothing to interrupt server-side).
 */
export function VoiceOrb({
  state,
  onTap,
  disabled,
}: {
  state: AgentState;
  onTap: () => void;
  disabled?: boolean;
}) {
  const pulse = state === "listening" || state === "speaking";
  return (
    <div className={`orb-wrap state-${state}${pulse ? " pulse" : ""}`}>
      <button
        type="button"
        className="orb"
        onClick={onTap}
        disabled={disabled || state === "thinking"}
        aria-label={LABEL[state]}
      >
        <span className="glyph" aria-hidden>
          {GLYPH[state]}
        </span>
      </button>
    </div>
  );
}
