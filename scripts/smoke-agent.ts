// `npm run smoke` — NO-NETWORK smoke test of the agent core.
//
// Drives the SAME runAgent()/tool/query stack the API route uses, but with a
// MOCKED language model (ai/test MockLanguageModelV4) that emits scripted tool
// calls — so nothing hits the network and no API key is needed. Runs against an
// isolated .smoke.db (never Turso; see use-smoke-db.js, imported first).
//
// Asserts:
//   A. Happy path: checkAvailability → bookAppointment executes and returns a
//      booking payload with a TFD- confirmation code.
//   B. Unknown slotId is rejected — no booking is produced or persisted.
//   C. Booking atomicity: two concurrent bookAppointment calls on the SAME slot
//      resolve to exactly one success.
//   D. Guard short-circuit: the per-IP limiter blocks past PER_IP_LIMIT.
//   E. Turn cap: overTurnCap() trips past MAX_TURNS.
//   F. Model-call metering: onModelCall fires per model call; the global budget
//      trips at the MODEL-CALL level and yields a friendly resting message.
//   G. IP spoof resistance: a spoofed leftmost x-forwarded-for can't mint a fresh
//      bucket when x-real-ip is present; rightmost XFF hop is used otherwise.
//   H. calendar_full is reachable: booking MAX_ACTIVE_BOOKINGS then one more
//      reports calendar_full.
//   I. Reset auth: when RESET_SECRET is set, a request without the secret is
//      rejected (route returns 403); an unset secret allows freely.
import "./use-smoke-db.js"; // MUST be first: sets DEMO_DB_URL before lib/db loads
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import { runAgent } from "../lib/agent.js";
import { runSeed } from "../lib/seed.js";
import { getOpenSlots, bookSlot, countActiveBookings, getSlotById, MAX_ACTIVE_BOOKINGS } from "../lib/queries.js";
import {
  checkRateLimits,
  clientIp,
  recordModelCall,
  modelBudgetAvailable,
  resetAuthorized,
  DEMO_RESTING_MESSAGE,
} from "../lib/guards.js";
import { PER_IP_LIMIT, DAILY_MODEL_CALLS, overTurnCap } from "../lib/config.js";
import type { ChatMessage } from "../lib/types.js";

// --- Tiny scripted mock model ----------------------------------------------
type Part =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string };
interface Step {
  content: Part[];
  finishReason: "tool-calls" | "stop";
}

function scriptedModel(script: Step[]): LanguageModel {
  let i = 0;
  const config = {
    doGenerate: async () => {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return {
        content: step.content,
        finishReason: step.finishReason,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  } as unknown as ConstructorParameters<typeof MockLanguageModelV4>[0];
  return new MockLanguageModelV4(config) as unknown as LanguageModel;
}

const toolCall = (id: string, name: string, args: unknown): Part => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(args),
});

// --- Assertion helpers ------------------------------------------------------
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const USER = (content: string): ChatMessage => ({ role: "user", content });

async function main() {
  console.log("smoke: mocked LLM, isolated .smoke.db, no network\n");
  await runSeed();

  const free = await getOpenSlots(undefined, 20);
  if (free.length < 3) throw new Error("seed produced too few free slots for the smoke test");
  const happySlot = free[0];
  const raceSlot = free[1];

  // --- A. Happy path ---------------------------------------------------------
  const happyModel = scriptedModel([
    { content: [toolCall("c1", "checkAvailability", { date: happySlot.date })], finishReason: "tool-calls" },
    {
      content: [toolCall("c2", "bookAppointment", { slotId: happySlot.slotId, name: "Alex Kim", email: "alex@acme.co" })],
      finishReason: "tool-calls",
    },
    { content: [{ type: "text", text: "You're all set!" }], finishReason: "stop" },
  ]);
  const happy = await runAgent([USER("Book me the first available demo")], { model: happyModel });
  const seq = happy.toolCalls.map((t) => t.name);
  check("A1 tool sequence checkAvailability→bookAppointment",
    seq[0] === "checkAvailability" && seq[1] === "bookAppointment", seq.join(","));
  check("A2 booking payload returned with TFD code",
    !!happy.booking && /^TFD-[A-Z0-9]{4}$/.test(happy.booking.code),
    happy.booking ? happy.booking.code : "(none)");
  check("A3 slot persisted as booked",
    (await getSlotById(happySlot.slotId))?.status === "booked");
  check("A4 exactly one booking in DB", (await countActiveBookings()) === 1);

  // --- B. Unknown slotId rejected -------------------------------------------
  const bogusModel = scriptedModel([
    { content: [toolCall("c1", "bookAppointment", { slotId: "2099-01-01T09:00", name: "No One", email: "no@one.com" })], finishReason: "tool-calls" },
    { content: [{ type: "text", text: "Sorry, that slot isn't available." }], finishReason: "stop" },
  ]);
  const bogus = await runAgent([USER("Book slot 2099-01-01T09:00")], { model: bogusModel });
  check("B1 no booking payload for unknown slot", bogus.booking === undefined);
  const direct = await bookSlot("2099-01-01T09:00", "No One", "no@one.com");
  check("B2 bookSlot rejects unknown slot", !direct.ok && direct.reason === "unknown_slot");
  check("B3 booking count unchanged", (await countActiveBookings()) === 1);

  // --- C. Booking atomicity (concurrent same-slot) --------------------------
  const [r1, r2] = await Promise.all([
    bookSlot(raceSlot.slotId, "Racer One", "one@race.com"),
    bookSlot(raceSlot.slotId, "Racer Two", "two@race.com"),
  ]);
  const wins = [r1, r2].filter((r) => r.ok).length;
  const taken = [r1, r2].filter((r) => !r.ok && r.reason === "taken").length;
  check("C1 exactly one concurrent booking wins", wins === 1, `wins=${wins} taken=${taken}`);

  // --- D. Guard short-circuit ------------------------------------------------
  const ip = "203.0.113.7";
  const verdicts = Array.from({ length: PER_IP_LIMIT + 1 }, () => checkRateLimits(ip));
  const allowed = verdicts.filter((v) => v.ok).length;
  const blocked = verdicts[verdicts.length - 1];
  check("D1 limiter allows exactly PER_IP_LIMIT then blocks",
    allowed === PER_IP_LIMIT && !blocked.ok, `allowed=${allowed}`);

  // --- E. Turn cap -----------------------------------------------------------
  const many = Array.from({ length: 21 }, (_, i) => USER(`turn ${i}`));
  const ok20 = Array.from({ length: 20 }, (_, i) => USER(`turn ${i}`));
  check("E1 overTurnCap trips past MAX_TURNS", overTurnCap(many) === true && overTurnCap(ok20) === false);

  // --- F. Model-call metering + budget trip ----------------------------------
  // F1: onModelCall fires once per model call (step), not once per agent request.
  // A checkAvailability-then-answer turn is exactly two model calls.
  const meterDay = free[2]?.date ?? happySlot.date;
  const meterModel = scriptedModel([
    { content: [toolCall("m1", "checkAvailability", { date: meterDay })], finishReason: "tool-calls" },
    { content: [{ type: "text", text: "Here are the open times." }], finishReason: "stop" },
  ]);
  let modelCalls = 0;
  await runAgent([USER("What's open?")], { model: meterModel, onModelCall: () => { modelCalls += 1; } });
  check("F1 onModelCall fires once per model call (metered at model level)", modelCalls === 2, `calls=${modelCalls}`);

  // F2: the GLOBAL daily budget trips at the model-call level → friendly message.
  check("F2a budget available before exhaustion", modelBudgetAvailable() === true);
  for (let i = 0; i < DAILY_MODEL_CALLS; i++) recordModelCall();
  check("F2b budget trips exactly at DAILY_MODEL_CALLS model calls", modelBudgetAvailable() === false);
  check("F2c resting message is a friendly notice, not an error",
    typeof DEMO_RESTING_MESSAGE === "string" && /resting|tomorrow/i.test(DEMO_RESTING_MESSAGE));

  // --- G. IP spoof resistance ------------------------------------------------
  const reqReal = (xffLeft: string) =>
    new Request("http://x/api/agent", {
      headers: { "x-real-ip": "198.51.100.9", "x-forwarded-for": `${xffLeft}, 70.0.0.1` },
    });
  const keyA = clientIp(reqReal("1.2.3.4"));
  const keyB = clientIp(reqReal("9.9.9.9")); // attacker rotates the spoofable leftmost hop
  check("G1 spoofed leftmost XFF can't mint a fresh bucket when x-real-ip present",
    keyA === keyB && keyA === "198.51.100.9", `${keyA} vs ${keyB}`);
  const noReal = new Request("http://x/api/agent", { headers: { "x-forwarded-for": "1.2.3.4, 70.0.0.1" } });
  check("G2 without x-real-ip, the rightmost (trusted) XFF hop is used",
    clientIp(noReal) === "70.0.0.1", clientIp(noReal));

  // --- H. calendar_full reachable at MAX_ACTIVE_BOOKINGS ----------------------
  await runSeed(); // clean slate: drop the bookings the checks above created
  check("H0 MAX_ACTIVE_BOOKINGS below the free-slot count so full is reachable", MAX_ACTIVE_BOOKINGS === 30);
  const pool = await getOpenSlots(undefined, MAX_ACTIVE_BOOKINGS + 5);
  if (pool.length <= MAX_ACTIVE_BOOKINGS) throw new Error("seed produced too few free slots for the calendar_full test");
  let booked = 0;
  for (let i = 0; i < MAX_ACTIVE_BOOKINGS; i++) {
    const r = await bookSlot(pool[i].slotId, `Filler ${i}`, `f${i}@demo.co`);
    if (r.ok) booked += 1;
  }
  const overflow = await bookSlot(pool[MAX_ACTIVE_BOOKINGS].slotId, "One Too Many", "over@demo.co");
  check("H1 first MAX_ACTIVE_BOOKINGS bookings all succeed", booked === MAX_ACTIVE_BOOKINGS, `booked=${booked}`);
  check("H2 the next booking reports calendar_full", !overflow.ok && overflow.reason === "calendar_full");

  // --- I. Reset authorization ------------------------------------------------
  const resetReq = (q = "") => new Request(`http://x/api/reset${q}`, { headers: q.includes("hdr") ? { "x-reset-secret": "sm0ke" } : {} });
  process.env.RESET_SECRET = "sm0ke";
  check("I1 reset without the secret is rejected (route → 403) when RESET_SECRET set",
    resetAuthorized(resetReq()) === false);
  check("I2 reset with matching ?secret= is allowed", resetAuthorized(resetReq("?secret=sm0ke")) === true);
  check("I3 reset with matching x-reset-secret header is allowed", resetAuthorized(resetReq("?hdr=1")) === true);
  delete process.env.RESET_SECRET;
  check("I4 reset is open when RESET_SECRET is unset (local dev)", resetAuthorized(resetReq()) === true);

  console.log(`\n${failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures} failing checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
