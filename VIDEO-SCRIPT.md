# Video script — Tessera Front Desk (~60s)

Target: ~150 spoken words. One take, screen recording with mic.

---

**[Problem — 0:00]**
Booking a demo call usually means a form, or worse, phone tag. What if you could
just *ask*?

**[Voice booking, end-to-end — 0:08]**
This is Tessera’s front desk — a voice agent running entirely in the browser.
I tap the orb and talk.
> “I’d like to book a product demo for next Tuesday.”

It checks the real calendar, offers open times, and takes my name and email — all
by voice. Notice it reads the details *back* to me before booking anything.
> “Yes, that’s correct.”

**[Confirmation + lookup — 0:30]**
Booked. Here’s the confirmation card — date, time, and a code. And I can look it
right back up by voice using that code.

**[Metrics — 0:40]**
Under the hood it’s a tool-using agent. A 15-conversation eval scores it on
booking the right slot and never inventing one — 100% task-completion, 15 of 15
(gemini-flash-lite-latest, 2026-07-16, `npm run eval`) right here.

**[Firefox fallback — 0:48]**
No microphone, or on Firefox? It falls back to text automatically — same agent,
same booking.

**[Close — 0:54]**
Zero runtime cost, and the core drops straight onto Vapi or Twilio for real phone
calls. Built with Claude Code.
