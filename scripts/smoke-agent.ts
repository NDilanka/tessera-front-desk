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
import "./use-smoke-db.js"; // MUST be first: sets DEMO_DB_URL before lib/db loads
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";
import { runAgent } from "../lib/agent.js";
import { runSeed } from "../lib/seed.js";
import { getOpenSlots, bookSlot, countActiveBookings, getSlotById } from "../lib/queries.js";
import { checkRateLimits } from "../lib/guards.js";
import { PER_IP_LIMIT, overTurnCap } from "../lib/config.js";
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

  console.log(`\n${failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures} failing checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
