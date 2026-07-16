# Tessera Front Desk — voice booking agent

A browser-native **voice** assistant that books product-demo calls for *Tessera*
(a fictional B2B workspace-management SaaS). Push to talk, hear the assistant
reply, and walk away with a confirmation code — no phone number, no telephony
vendor, no per-minute cost. The whole thing runs at **$0** on free-tier LLMs.

> Portfolio demo. Tessera is invented; the calendar and bookings are seeded local
> data. The point is to show a real, tool-using voice agent end-to-end.

---

## What it does

- **Talk to book.** Tap the orb, say *“I’d like a demo next Tuesday.”* The agent
  checks real availability, collects your name and email, reads the details back,
  and books you in — then shows a confirmation card with a `TFD-XXXX` code.
- **Look up a booking** by its confirmation code, by voice.
- **Speaks its replies** with the browser’s built-in text-to-speech, and
  **transcribes your speech** with the browser’s built-in speech recognition.
- **Grounded in a real calendar.** The agent can only offer and book slots that
  actually exist and are free — it cannot invent a time or a confirmation code
  (see [DECISIONS.md](./DECISIONS.md)).

## How it works (architecture)

```
Browser (client)                         Server (stateless)
─────────────────                        ──────────────────
push-to-talk orb                         POST /api/agent  { messages }
  Web Speech STT  ──transcript──▶          ├ abuse guards (per-IP / per-day)
  state machine                            ├ runAgent()  → Vercel AI SDK generateText
  speechSynthesis TTS ◀──{text}──          │    tools: checkAvailability,
  confirmation card  ◀──{booking}          │           bookAppointment, lookupBooking
                                           └ libSQL (SQLite file / Turso)
                                         POST /api/reset  → reseed the demo calendar
```

- **One shared brain.** The API route, the offline smoke test, and the multi-turn
  eval all call the *same* `runAgent()` in `lib/agent.ts`. There is no second,
  drifting copy of the tool logic.
- **Stateless server.** The client holds the full transcript and sends it whole
  each turn; the server keeps no session.
- **Half-duplex voice.** `idle → listening → thinking → speaking → idle`. One
  utterance per tap; tap while it’s speaking to cut in. (Rationale in DECISIONS.)
- **Atomic booking.** A slot is claimed with a conditional
  `UPDATE … WHERE status='free'`, so even two simultaneous bookings of the same
  slot resolve to exactly one winner.

## Quickstart

```bash
# 1. Install
npm install

# 2. Add a free key (primary path is Google AI Studio, free tier)
cp env.example .env.local
#   then set GEMINI_API_KEY=...   (https://aistudio.google.com/apikey)
#   — or set GROQ_API_KEY for the Groq/Llama fallback instead.

# 3. Seed the local demo calendar (creates local.db)
npm run seed

# 4. Run it
npm run dev            # http://localhost:3000
```

Then open the app in Chrome/Edge/Safari, tap the orb, and speak. No key yet? The
app still loads and tells you it isn’t configured — nothing crashes.

### Scripts

| Command            | What it does                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `npm run dev`      | Next.js dev server.                                                 |
| `npm run build`    | Production build (Vercel Hobby target).                             |
| `npm run seed`     | Reseed the local calendar (`local.db`).                             |
| `npm run smoke`    | **No-network** agent smoke test (mocked LLM). Always runnable.      |
| `npm run eval`     | Multi-turn LLM eval (needs a key; otherwise reports *pending*).     |
| `npm run typecheck`| App + scripts type-check.                                           |

## Browser matrix

| Browser        | Speech-to-text (mic) | Text-to-speech | Experience                          |
| -------------- | -------------------- | -------------- | ----------------------------------- |
| Chrome         | ✅ Yes               | ✅ Yes         | Full voice.                         |
| Edge           | ✅ Yes               | ✅ Yes         | Full voice.                         |
| Safari         | ✅ Yes               | ✅ Yes         | Full voice.                         |
| **Firefox**    | ❌ No `SpeechRecognition` | ✅ Yes    | **Text-input fallback**, replies still spoken. |

Speech recognition uses the Web Speech API (`SpeechRecognition` /
`webkitSpeechRecognition`), which Firefox doesn’t implement. There, the mic is
automatically replaced by a text box. A **“Type instead”** toggle is also present
in *every* browser, so the demo is fully usable without a microphone.

## Metrics

The eval (`npm run eval`) runs 15 scripted multi-turn conversations through the
real agent against a freshly-seeded database and reports a **task-completion
rate** (gate ≥ 80%, i.e. 12/15) plus tool-sequence accuracy.

> **Metrics: [PENDING]** — the numbers are filled in from a live run once a
> `GEMINI_API_KEY` is present. Without a key the eval prints a *pending* notice
> and exits cleanly (it does not fabricate a score). Re-run `npm run eval` after
> adding a key and paste the printed rates here.

## Cost

$0 at rest and $0 to demo: `gemini-flash-latest` on Google AI Studio’s free tier
(~10 requests/min, ~250/day), the local SQLite file, and the browser’s own
STT/TTS. The in-memory abuse guards and free-tier quotas are the backstops
against a runaway bill. Because one booking turn can make several model calls,
the global budget is metered at the **model-call** level, not per request:

- **6 requests / IP / minute** (burst) and **25 requests / IP / day** (one
  visitor can’t monopolise the demo).
- **200 model calls / day** globally, under the ~250/day free-tier ceiling. When
  it’s spent, the agent politely says the demo is resting until tomorrow.

These counters are per-instance (in-process) — see [DECISIONS.md](./DECISIONS.md)
#9 — so on serverless they’re best-effort; the provider quota is the hard limit.

## Deploying (persistence)

The app runs on any Vercel deploy with no database configured — it falls back to
an ephemeral `/tmp` SQLite file that is **auto-seeded per instance**. That’s fine
to click through a demo, but each serverless instance has its own calendar, so
**bookings may not survive between requests**. For a persistent, shared calendar,
set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (free hosted Turso) — this is the
**recommended** production setup. Set `RESET_SECRET` too so only you can reseed
the calendar via `/api/reset`. See [DECISIONS.md](./DECISIONS.md) #8.

## Portability to real telephony

This demo is browser-first on purpose (zero cost, instant to try), but the agent
core is the reusable part. `lib/agent.ts` — the tools, the grounding rules, the
booking logic — is transport-agnostic. To put this on a **phone number**, keep
`runAgent()` and swap the browser’s mic/speaker for a telephony voice platform:

- **[Vapi](https://vapi.ai)** or **[Retell](https://retellai.com)** — hand them a
  webhook/function-call endpoint; point their function calls at the same three
  tools. They handle the STT/TTS/turn-taking and low-latency streaming.
- **[Twilio](https://www.twilio.com/docs/voice) Media Streams / ConversationRelay**
  — bridge the call audio to an STT/TTS pipeline and call `runAgent()` per turn.

The half-duplex state machine and Web Speech wrapper (`lib/speech.ts`) are the
browser-specific pieces you’d replace; everything behind `/api/agent` stays.

## Layout

```
app/            page.tsx (voice UI), api/agent, api/reset, layout, globals.css
components/      VoiceOrb, TranscriptPanel, ConfirmationCard
lib/             agent, config, specs, guards, db, schema, seed, queries, types, speech
data/            eval-dialogs.json (15 scripted conversations)
scripts/         seed, smoke-agent (no-network), eval-dialogs, load-env
```

See [DECISIONS.md](./DECISIONS.md) for the design trade-offs and
[VIDEO-SCRIPT.md](./VIDEO-SCRIPT.md) for the ~1-minute walkthrough script.
