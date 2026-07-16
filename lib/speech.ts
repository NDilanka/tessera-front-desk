// Browser speech wrapper: Web Speech API STT + speechSynthesis TTS, plus the
// feature detection the UI uses to fall back to a text box. Client-only — every
// function touches `window`, so it must run in a "use client" component.
//
// The Web Speech `SpeechRecognition` interface is not in TypeScript's DOM lib, so
// the minimal shapes we use are declared here rather than pulled from lib.dom.

// --- Minimal Web Speech typings ---------------------------------------------
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionResultListLike {
  length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechWindow extends Window {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** True if this browser can do speech-to-text (Chrome/Edge/Safari; NOT Firefox). */
export function speechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

/** True if this browser can speak text aloud. */
export function speechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// --- Speech-to-text ---------------------------------------------------------
export interface Recognizer {
  /** Begin listening for a SINGLE utterance. */
  start(): void;
  /** Stop listening (finalizes the current utterance). */
  stop(): void;
  /** Abort without emitting a final result. */
  abort(): void;
}

export interface RecognizerCallbacks {
  /** Live partial text while the caller is speaking (interim results). */
  onInterim: (text: string) => void;
  /** The finalized utterance once the caller stops. */
  onFinal: (text: string) => void;
  /** Recognition ended (naturally or via stop/abort). */
  onEnd: () => void;
  /** A recognition error (e.g. no-speech, not-allowed). */
  onError: (error: string) => void;
}

/**
 * Create a half-duplex recognizer for one-utterance-per-press push-to-talk.
 * `continuous` is false and `interimResults` true: the browser streams partial
 * text as `onInterim` and emits the settled utterance as `onFinal`. Returns null
 * if the browser has no SpeechRecognition (caller should use the text fallback).
 */
export function createRecognizer(cb: RecognizerCallbacks): Recognizer | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const rec = new Ctor();
  rec.lang = "en-US";
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    let interim = "";
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const text = result[0].transcript;
      if (result.isFinal) final += text;
      else interim += text;
    }
    if (interim) cb.onInterim(interim);
    if (final) cb.onFinal(final.trim());
  };
  rec.onerror = (e) => cb.onError(e.error);
  rec.onend = () => cb.onEnd();

  return {
    start: () => {
      try {
        rec.start();
      } catch {
        // start() throws if called while already started — safe to ignore.
      }
    },
    stop: () => rec.stop(),
    abort: () => rec.abort(),
  };
}

// --- Text-to-speech ---------------------------------------------------------
// Generation token for TTS. Every speak() claims the next id; an utterance's
// onend/onerror only runs its onEnd callback while its id is still current. This
// is the barge-in fix: cancelSpeech() bumps the generation, so the just-cancelled
// utterance's async `onend` can no longer clobber a state the caller has since
// moved on to (e.g. 'listening' after a tap-to-interrupt). Purely synchronous —
// safe on the server (functions are only called client-side).
let speechGeneration = 0;

/**
 * Speak `text` aloud. `onEnd` fires when speech finishes — but NOT if this
 * utterance was superseded by a later speak() or a cancelSpeech() (see the
 * generation token above). Cancels anything already speaking first so replies
 * never overlap; because the generation is bumped before that cancel, the prior
 * utterance's stale onend is ignored.
 */
export function speak(text: string, onEnd: () => void): void {
  const myGen = ++speechGeneration; // claim this generation before anything else
  if (!speechSynthesisSupported() || !text.trim()) {
    onEnd();
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 1.02;
  utter.pitch = 1;
  const finish = () => {
    if (myGen === speechGeneration) onEnd(); // ignore if superseded
  };
  utter.onend = finish;
  utter.onerror = finish;
  window.speechSynthesis.speak(utter);
}

/**
 * Stop any in-progress speech immediately (tap-to-interrupt). Bumps the speech
 * generation so the cancelled utterance's onend can't fire the stale onEnd that
 * would otherwise force the state machine back to 'idle'.
 */
export function cancelSpeech(): void {
  speechGeneration++;
  if (speechSynthesisSupported()) window.speechSynthesis.cancel();
}
