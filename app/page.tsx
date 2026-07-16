"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceOrb } from "@/components/VoiceOrb";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { ConfirmationCard } from "@/components/ConfirmationCard";
import {
  createRecognizer,
  speak,
  cancelSpeech,
  speechRecognitionSupported,
} from "@/lib/speech";
import type { Recognizer } from "@/lib/speech";
import type { AgentState } from "@/lib/types-client";
import type { ChatMessage, BookingConfirmation } from "@/lib/types";

/** Client-side hard cap on turns, matching the server's MAX_TURNS. */
const MAX_TURNS = 20;

const STATUS: Record<AgentState, string> = {
  idle: "Tap the orb and speak.",
  listening: "Listening… tap again when you’re done.",
  thinking: "Thinking…",
  speaking: "Speaking… tap to interrupt.",
};

export default function Home() {
  const [state, setState] = useState<AgentState>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [interim, setInterim] = useState("");
  const [booking, setBooking] = useState<BookingConfirmation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [textValue, setTextValue] = useState("");
  const [sttSupported, setSttSupported] = useState(true);

  const recognizerRef = useRef<Recognizer | null>(null);
  const gotFinalRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  // Feature-detect once on mount; Firefox has no SpeechRecognition → text mode.
  useEffect(() => {
    const supported = speechRecognitionSupported();
    setSttSupported(supported);
    if (!supported) setTextMode(true);
  }, []);

  const userTurns = messages.filter((m) => m.role === "user").length;

  // --- Server turn ----------------------------------------------------------
  const speakThenIdle = useCallback((text: string) => {
    setState("speaking");
    speak(text, () => setState("idle"));
  }, []);

  const send = useCallback(
    async (next: ChatMessage[]) => {
      setState("thinking");
      setInterim("");
      try {
        const res = await fetch("/api/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: next }),
        });
        const data = (await res.json()) as {
          text?: string;
          booking?: BookingConfirmation | null;
          message?: string;
          error?: string;
        };

        if (!res.ok) {
          const msg = data.message ?? "Something went wrong. Please try again.";
          setNotice(msg);
          speakThenIdle(msg);
          return;
        }

        const reply = data.text?.trim() || "Sorry, I didn’t catch that.";
        if (data.booking) setBooking(data.booking);
        setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
        speakThenIdle(reply);
      } catch {
        const msg = "I couldn’t reach the booking service. Please try again.";
        setNotice(msg);
        speakThenIdle(msg);
      }
    },
    [speakThenIdle],
  );

  // Route a finalized utterance (from mic or text box) into the transcript + server.
  const submitUtterance = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) {
        setState("idle");
        return;
      }
      if (userTurns >= MAX_TURNS) {
        setNotice("Session limit reached — reset the demo to start a new booking.");
        setState("idle");
        return;
      }
      setNotice(null);
      const next: ChatMessage[] = [
        ...messagesRef.current,
        { role: "user", content: text },
      ];
      setMessages(next);
      void send(next);
    },
    [send, userTurns],
  );

  // --- Listening ------------------------------------------------------------
  const startListening = useCallback(() => {
    setInterim("");
    gotFinalRef.current = false;
    const rec = createRecognizer({
      onInterim: (t) => setInterim(t),
      onFinal: (t) => {
        gotFinalRef.current = true;
        submitUtterance(t);
      },
      onEnd: () => {
        // Ended with no final result (silence / abort) → back to idle.
        setInterim("");
        setState((s) => (s === "listening" && !gotFinalRef.current ? "idle" : s));
      },
      onError: (err) => {
        if (err !== "no-speech" && err !== "aborted") {
          setNotice(`Microphone error: ${err}. You can type instead.`);
        }
        setState((s) => (s === "listening" ? "idle" : s));
      },
    });
    if (!rec) {
      setSttSupported(false);
      setTextMode(true);
      return;
    }
    recognizerRef.current = rec;
    setState("listening");
    rec.start();
  }, [submitUtterance]);

  const stopListening = useCallback(() => {
    recognizerRef.current?.stop();
  }, []);

  // --- Orb tap: the whole half-duplex control -------------------------------
  const onOrbTap = useCallback(() => {
    if (state === "speaking") {
      cancelSpeech(); // barge-in: cut the reply short…
      startListening(); // …and start a fresh utterance.
      return;
    }
    if (state === "listening") {
      stopListening();
      return;
    }
    if (state === "idle") {
      if (textMode) return; // voice disabled in text mode
      startListening();
    }
  }, [state, textMode, startListening, stopListening]);

  // --- Text fallback --------------------------------------------------------
  const onTextSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (state === "thinking" || state === "listening") return;
      cancelSpeech();
      const v = textValue;
      setTextValue("");
      submitUtterance(v);
    },
    [state, textValue, submitUtterance],
  );

  // --- Reset ----------------------------------------------------------------
  const onReset = useCallback(async () => {
    cancelSpeech();
    recognizerRef.current?.abort();
    setState("idle");
    setMessages([]);
    setInterim("");
    setBooking(null);
    setNotice(null);
    setTextValue("");
    try {
      await fetch("/api/reset", { method: "POST" });
    } catch {
      /* best-effort reseed; UI is already cleared */
    }
  }, []);

  return (
    <div className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="dot" aria-hidden />
          <span>
            Tessera Front Desk
            <small>Voice booking · demo calls</small>
          </span>
        </div>
        <button className="reset-link" onClick={onReset}>
          Reset demo
        </button>
      </header>

      <section className="stage">
        <VoiceOrb
          state={state}
          onTap={onOrbTap}
          disabled={textMode && state !== "speaking"}
        />
        <div className="status-line">
          {notice ? <b>{notice}</b> : STATUS[state]}
        </div>

        <div className="controls">
          <button
            className="toggle"
            onClick={() => {
              cancelSpeech();
              recognizerRef.current?.abort();
              setState("idle");
              setTextMode((m) => !m);
            }}
          >
            {textMode ? "Use voice" : "Type instead"}
          </button>
        </div>

        {textMode ? (
          <form className="text-entry" onSubmit={onTextSubmit}>
            <input
              type="text"
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              placeholder="Type your message…"
              disabled={state === "thinking"}
              autoFocus
            />
            <button type="submit" disabled={state === "thinking" || !textValue.trim()}>
              Send
            </button>
          </form>
        ) : (
          <p className="hint">
            {sttSupported
              ? "Push-to-talk · one sentence per tap"
              : "Voice isn’t available in this browser — using text."}
          </p>
        )}
      </section>

      <TranscriptPanel messages={messages} interim={interim} />

      {booking ? <ConfirmationCard booking={booking} /> : null}
      {notice && !booking ? <p className="notice">{notice}</p> : null}
    </div>
  );
}
