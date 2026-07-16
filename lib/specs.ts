// Tool specs: name → description + Zod input schema. This module is deliberately
// free of any server-only imports (no db, no next/*), so it can be imported by
// BOTH the real tools (lib/agent.ts, which adds the executors) and any harness
// that only needs the shapes.
import { z } from "zod";

export const toolSpecs = {
  checkAvailability: {
    description:
      "Look up open product-demo slots. Optionally pass a specific day. Returns a list of open slots, each with an exact `slotId` and a human-readable `label`. You must only ever offer or book slots that this tool returned — never invent one.",
    inputSchema: z.object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
        .optional()
        .describe(
          "The day to check, as YYYY-MM-DD, resolved from the caller's words against today's date. Omit to get the next few upcoming open slots across all days.",
        ),
    }),
  },
  bookAppointment: {
    description:
      "Book a demo call into an EXACT slot. `slotId` must be copied verbatim from a slot that checkAvailability returned in this conversation — never a free-text date or a slot you made up. Confirm the slot, name, and email with the caller before calling this.",
    inputSchema: z.object({
      slotId: z
        .string()
        .min(1)
        .describe("The exact slotId string from a checkAvailability result."),
      name: z.string().min(1).describe("The caller's full name."),
      email: z
        .string()
        .email("must be a valid email")
        .describe("The caller's email address."),
    }),
  },
  lookupBooking: {
    description:
      "Look up an existing booking by its confirmation code (format TFD-XXXX) to tell the caller their booked day and time.",
    inputSchema: z.object({
      confirmationCode: z
        .string()
        .min(1)
        .describe("The caller's confirmation code, e.g. TFD-Q7K2."),
    }),
  },
} as const;

export type ToolName = keyof typeof toolSpecs;

/** All tool names, for eval subsequence checks. */
export const TOOL_NAMES: ToolName[] = [
  "checkAvailability",
  "bookAppointment",
  "lookupBooking",
];
