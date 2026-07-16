// The agent core — the SINGLE function the API route, the eval, and the smoke
// test all run through. Given the full transcript it runs the model with the
// three booking tools and returns the spoken reply plus, when a booking was made
// on this turn, the confirmation payload for the client's booking card.
//
// The server is stateless: the client sends the whole transcript each turn and
// gets back { text, booking? }. No conversation state is kept here.
import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { resolveAgent, systemPrompt, MAX_STEPS } from "./config";
import { toolSpecs } from "./specs";
import {
  getOpenSlots,
  getSlotById,
  bookSlot,
  getBookingByCode,
} from "./queries";
import type { ChatMessage, BookingConfirmation } from "./types";

export interface RunAgentOptions {
  /** Override the model — used by the no-network smoke test with a mock. */
  model?: LanguageModel;
  /** Override "today" injected into the system prompt (test determinism). */
  today?: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

export interface AgentResult {
  text: string;
  booking?: BookingConfirmation;
  toolCalls: ToolCallRecord[];
}

/**
 * Build the three booking tools. `onBooking` is invoked with the confirmation the
 * moment a bookAppointment call succeeds, so callers can surface it (the route
 * for the card, the smoke test for its assertion) without re-parsing tool output.
 */
export function buildTools(onBooking: (b: BookingConfirmation) => void) {
  return {
    checkAvailability: tool({
      ...toolSpecs.checkAvailability,
      execute: async ({ date }) => {
        const slots = await getOpenSlots(date);
        if (slots.length === 0) {
          return {
            slots: [],
            message: date
              ? `No open demo slots on ${date}. Offer the caller the next open day instead.`
              : "No open demo slots are available right now.",
          };
        }
        return {
          slots: slots.map((s) => ({ slotId: s.slotId, label: s.label })),
        };
      },
    }),

    bookAppointment: tool({
      ...toolSpecs.bookAppointment,
      execute: async ({ slotId, name, email }) => {
        const result = await bookSlot(slotId, name, email);
        if (result.ok) {
          onBooking(result.booking);
          return {
            ok: true as const,
            confirmationCode: result.booking.code,
            slot: result.booking.label,
            name,
            email,
          };
        }
        if (result.reason === "unknown_slot") {
          return {
            ok: false as const,
            error: "unknown_slot",
            message:
              "That slot id is not one I offered. Call checkAvailability again and only book a slot it returns.",
          };
        }
        if (result.reason === "calendar_full") {
          return {
            ok: false as const,
            error: "calendar_full",
            message:
              "The demo calendar is completely full right now. Apologize and suggest checking back later.",
          };
        }
        return {
          ok: false as const,
          error: "taken",
          message:
            "That slot was just booked by someone else. Apologize and call checkAvailability again to offer another time.",
        };
      },
    }),

    lookupBooking: tool({
      ...toolSpecs.lookupBooking,
      execute: async ({ confirmationCode }) => {
        const booking = await getBookingByCode(confirmationCode.trim().toUpperCase());
        if (!booking) {
          return {
            found: false as const,
            message: `No booking found for ${confirmationCode}.`,
          };
        }
        return {
          found: true as const,
          confirmationCode: booking.code,
          slot: booking.label,
          name: booking.name,
          email: booking.email,
        };
      },
    }),
  };
}

/** Flatten every tool call across all steps into a plain name+args list. */
function collectToolCalls(
  steps: Awaited<ReturnType<typeof generateText>>["steps"],
): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const step of steps) {
    for (const call of step.toolCalls) {
      calls.push({
        name: call.toolName,
        args: (call.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return calls;
}

/**
 * Run one turn of the agent over the full transcript. Stateless: everything the
 * model needs is in `messages`. Returns the spoken text, an optional booking
 * confirmation (set iff a bookAppointment succeeded this turn), and the tool-call
 * trace (used by the eval).
 */
export async function runAgent(
  messages: ChatMessage[],
  opts: RunAgentOptions = {},
): Promise<AgentResult> {
  const model = opts.model ?? resolveAgent().model;
  let booking: BookingConfirmation | undefined;
  const tools = buildTools((b) => {
    booking = b; // last successful booking on this turn wins
  });

  const result = await generateText({
    model,
    system: systemPrompt(opts.today),
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });

  return { text: result.text, booking, toolCalls: collectToolCalls(result.steps) };
}
