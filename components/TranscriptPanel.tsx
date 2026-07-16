"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/types";

/**
 * The rolling conversation. Shows settled turns plus, while the caller is
 * speaking, a live interim bubble of the partial transcription. Auto-scrolls to
 * the newest line.
 */
export function TranscriptPanel({
  messages,
  interim,
}: {
  messages: ChatMessage[];
  interim: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, interim]);

  const empty = messages.length === 0 && !interim;

  return (
    <div className="transcript" aria-live="polite">
      {empty ? (
        <p className="empty">
          Say something like “I’d like to book a demo for next Tuesday.”
        </p>
      ) : (
        messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.content}
          </div>
        ))
      )}
      {interim ? <div className="bubble interim">{interim}</div> : null}
      <div ref={endRef} />
    </div>
  );
}
