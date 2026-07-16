// Central agent config — the model, its $0 provider paths, the spend guards, and
// the system prompt live here so the knobs are all in one obvious place.
//
// Provider resolution mirrors the sibling tessera-ops-agent's gemini-free-path:
// a NATIVE @ai-sdk/google primary (so tool-calling isn't skewed by an OpenAI
// compat layer) with an env-gated Groq fallback over the OpenAI-compatible
// endpoint. Both are free tiers — the app and the eval run at $0.
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

// --- Models -----------------------------------------------------------------
/**
 * PRIMARY: Google AI Studio's `gemini-flash-lite-latest` alias, on the free
 * tier, reached through the native `@ai-sdk/google` provider. This is what
 * makes the voice booking agent and the multi-turn eval cost $0.
 *
 * Why lite, and why an alias (measured 2026-07-16 on a fresh free key):
 * pinned `gemini-2.5-flash` is refused for new keys, and `gemini-flash-latest`
 * resolves to gemini-3.5-flash whose free quota is ~20 requests/DAY — one
 * visitor would black out the demo. The flash-lite alias carries a real free
 * quota (~15 RPM / ~1,000 RPD). Tradeoff: the serving model can change under
 * us, which is why every published metric is labeled with the model that
 * produced it at measurement time.
 */
export const GEMINI_MODEL = "gemini-flash-lite-latest";

/**
 * FALLBACK: Groq's `llama-3.3-70b-versatile`, served over Groq's OpenAI-compatible
 * endpoint via `@ai-sdk/openai`'s `createOpenAI({ baseURL })`. Also a free tier.
 * Only used when GEMINI_API_KEY is absent and GROQ_API_KEY is present.
 */
export const GROQ_MODEL = "llama-3.3-70b-versatile";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// --- Provider ---------------------------------------------------------------
/** True when the agent has a usable key on either free path. */
export function agentConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);
}

/** The resolved provider path, for logging / eval pacing decisions. */
export type AgentProvider = "google" | "groq";

/**
 * Resolve the agent language model plus the concrete model id and provider that
 * were selected. Precedence (first present key wins):
 *   1. GEMINI_API_KEY → native @ai-sdk/google `gemini-flash-latest` (primary).
 *   2. GROQ_API_KEY   → `llama-3.3-70b-versatile` via Groq's OpenAI-compat endpoint.
 *
 * Call sites gate on `agentConfigured()` first; when neither key is present this
 * defaults to the Gemini path so the upstream call surfaces a clear auth error.
 */
export function resolveAgent(): {
  model: LanguageModel;
  modelId: string;
  provider: AgentProvider;
} {
  if (!process.env.GEMINI_API_KEY && process.env.GROQ_API_KEY) {
    const groq = createOpenAI({
      baseURL: GROQ_BASE_URL,
      apiKey: process.env.GROQ_API_KEY,
    });
    return { model: groq(GROQ_MODEL), modelId: GROQ_MODEL, provider: "groq" };
  }
  const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
  return { model: google(GEMINI_MODEL), modelId: GEMINI_MODEL, provider: "google" };
}

// --- Turn / step budgets ----------------------------------------------------
/** Max agent steps (tool call + continuation loops) per turn. */
export const MAX_STEPS = 6;
/** Hard cap on conversation turns (user messages) the server will process. */
export const MAX_TURNS = 20;

/** Count of user turns in a transcript. */
export function userTurnCount(messages: { role: string }[]): number {
  return messages.filter((m) => m.role === "user").length;
}

/** True when a transcript exceeds the server-side turn cap. */
export function overTurnCap(messages: { role: string }[]): boolean {
  return userTurnCount(messages) > MAX_TURNS;
}

// --- Abuse guards (see lib/guards.ts) ---------------------------------------
/** Per-IP sliding window: at most this many agent requests per WINDOW_MS. */
export const PER_IP_LIMIT = 6;
export const WINDOW_MS = 60_000; // 1 minute
/** Per-IP daily cap: at most this many agent requests per IP per UTC day. */
export const PER_IP_DAILY_CAP = 25;
/**
 * Global daily MODEL-CALL budget. The real scarce resource is the shared
 * gemini-flash-latest free-tier quota (~250 requests/DAY at time of writing), and a
 * SINGLE agent request can make up to MAX_STEPS (6) model calls. So we meter
 * model calls — not agent requests — against this budget, kept comfortably under
 * 250 for headroom. See lib/guards.ts (recordModelCall / modelBudgetAvailable).
 */
export const DAILY_MODEL_CALLS = 200;

// --- System prompt ----------------------------------------------------------
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Today as YYYY-MM-DD plus weekday name, injected into the prompt server-side. */
export function todayContext(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date} (${WEEKDAY[now.getDay()]})`;
}

/**
 * The agent's system prompt. `today` is injected so it can resolve relative dates
 * ("tomorrow", "next Tuesday") to concrete YYYY-MM-DD values for checkAvailability.
 * Replies are SHORT because they are spoken aloud by the browser's TTS.
 */
export function systemPrompt(today = todayContext()): string {
  return `You are the Tessera front-desk assistant. Tessera is a B2B workspace-management SaaS. Your one job is to help callers book a 30-minute product-demo call, and to look up an existing booking.

TODAY'S DATE is ${today}. Resolve every relative date the caller gives ("today", "tomorrow", "next Tuesday", "the 21st") against this date before calling a tool.

Your replies are SPOKEN ALOUD to the caller, so:
- Keep every reply SHORT and natural — 1 to 3 sentences. No lists, no markdown, no emoji.
- Speak times and dates the way a person would ("Monday the 20th at 10 AM").

How to book:
1. Use checkAvailability to see open slots for the day the caller wants. It returns explicit slots, each with a slotId and a human label. NEVER invent, guess, or reword a slot — only ever offer slots it returned. One check per day is enough — do NOT call it again for a day you already checked.
2. Collect the caller's full name and email if you don't have them yet.
3. Read the chosen slot, the name, and the email back to the caller and get a yes. If the caller has ALREADY told you to book (e.g. "book the earliest one", "yes, book it"), treat that as the yes — do not ask again.
4. Then call bookAppointment. Pass the slotId copied character-for-character from the checkAvailability result (e.g. "2026-07-20T10:00") — never a free-text date, and never reformatted (do not add seconds or a "Z", do not change the "T" to a dash). Then tell the caller the day, time, and their confirmation code.

Once the caller has named a slot, given their name and email, and confirmed (or already said to book), call bookAppointment IMMEDIATELY. Do NOT re-run checkAvailability to double-check first — you already have the slotId.

Rules:
- If checkAvailability returns nothing for that day, say so and offer the nearest open day it does return. Never claim a slot exists that wasn't returned.
- If bookAppointment reports the slot was just taken, apologize briefly and offer to re-check availability. Never invent a confirmation code.
- If bookAppointment says the slotId was not found, it returns the valid slotIds — immediately call bookAppointment again with one of those exact strings. Do NOT re-run checkAvailability.
- If the caller only asks to look up a booking, use lookupBooking with their confirmation code.
- If the request is ambiguous (no clear day/time, or a vague "sometime soon"), ask one short clarifying question instead of guessing — do NOT book.
- If the caller goes off-topic, politely steer back to booking a demo in one sentence.`;
}
