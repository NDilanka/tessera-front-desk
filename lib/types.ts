// Row types mirroring the database schema (lib/schema.ts) plus the small payloads
// the agent and client exchange. Every column comes back from libSQL as a plain
// value; these interfaces describe the shape after a row has been read.

export type SlotStatus = "free" | "booked";

/** A bookable product-demo slot. `slotId` is the canonical ISO-minute key. */
export interface Slot {
  slotId: string; // e.g. "2026-07-20T10:00" — echoed verbatim to bookAppointment
  label: string; // e.g. "Mon Jul 20, 10:00 AM" — spoken/printed, never parsed
  date: string; // YYYY-MM-DD, for day filtering
  status: SlotStatus;
}

/** A confirmed booking. `code` (TFD-XXXX) is the customer-facing reference. */
export interface Booking {
  code: string; // TFD-XXXX
  slotId: string;
  name: string;
  email: string;
  createdAt: string; // ISO 8601
}

/**
 * The confirmation payload surfaced to the client for the booking card, joined
 * with the slot's human label. Returned from runAgent when a booking succeeds
 * on the current turn.
 */
export interface BookingConfirmation {
  code: string;
  slotId: string;
  label: string;
  name: string;
  email: string;
}

/** One chat turn. The client holds the full transcript and sends it each turn. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}
