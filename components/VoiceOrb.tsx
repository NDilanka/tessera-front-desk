"use client";

import { Mic, Loader2, Volume2 } from "lucide-react";
import type { AgentState } from "@/lib/types-client";

/** iOS 26 Liquid Glass sphere: lucide glyph per state. */
const GLYPH: Record<AgentState, React.ReactNode> = {
  idle: <Mic strokeWidth={1.8} aria-hidden />,
  listening: <Mic strokeWidth={1.8} aria-hidden />,
  thinking: <Loader2 strokeWidth={1.8} aria-hidden />,
  speaking: <Volume2 strokeWidth={1.8} aria-hidden />,
};

const LABEL: Record<AgentState, string> = {
  idle: "Tap to talk",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Tap to stop",
};

/**
 * The single focal control: a state-colored Liquid Glass orb. Tapping it drives
 * the whole half-duplex flow — start listening from idle, or cancel speech
 * (→ listening) while speaking. Disabled during `thinking` (nothing to interrupt
 * server-side). The `state-{...}` wrap class + `--state-color` variable drive the
 * sphere's glow, tint wash and pulse ring (see globals.css).
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
        <span
          className={`glyph${state === "thinking" ? " is-spinning" : ""}`}
          aria-hidden
        >
          {GLYPH[state]}
        </span>
      </button>
    </div>
  );
}
