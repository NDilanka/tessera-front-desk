// Data access for the front-desk agent. Every query is parameterized — no string
// concatenation of user/model input into SQL. The booking write is the important
// one: it is an ATOMIC conditional UPDATE so a slot is handed to exactly one
// booker even under concurrent requests (see bookSlot).
import { db } from "./db";
import type { Slot, Booking, BookingConfirmation } from "./types";
import type { Row } from "@libsql/client";

function rows<T>(r: { rows: Row[] }): T[] {
  return r.rows as unknown as T[];
}

/**
 * Hard cap on active demo bookings before the calendar reports itself full. Set
 * BELOW the seeded free-slot count (~36–48 depending on the run day) so the
 * `calendar_full` branch is actually reachable in a demo — and asserted by the
 * smoke test — rather than being dead code behind an unreachable ceiling.
 */
export const MAX_ACTIVE_BOOKINGS = 30;

/** Default number of upcoming free slots returned when no date is given. */
const DEFAULT_SLOT_LIMIT = 6;

// --- Availability -----------------------------------------------------------
/**
 * Open (free) slots. With a `date` (YYYY-MM-DD) returns every free slot that day;
 * without one, returns the next `limit` upcoming free slots across all days.
 * Ordered by slotId, which sorts chronologically because it is an ISO timestamp.
 */
export async function getOpenSlots(
  date?: string,
  limit = DEFAULT_SLOT_LIMIT,
): Promise<Slot[]> {
  if (date) {
    return rows<Slot>(
      await db.execute({
        sql: "SELECT * FROM slots WHERE date = ? AND status = 'free' ORDER BY slotId",
        args: [date],
      }),
    );
  }
  return rows<Slot>(
    await db.execute({
      sql: "SELECT * FROM slots WHERE status = 'free' ORDER BY slotId LIMIT ?",
      args: [limit],
    }),
  );
}

export async function getSlotById(slotId: string): Promise<Slot | null> {
  const r = await db.execute({
    sql: "SELECT * FROM slots WHERE slotId = ?",
    args: [slotId],
  });
  return (rows<Slot>(r)[0] as Slot | undefined) ?? null;
}

export async function countActiveBookings(): Promise<number> {
  const r = await db.execute("SELECT COUNT(*) AS n FROM bookings");
  return Number((r.rows[0] as unknown as { n: number }).n);
}

// --- Booking ----------------------------------------------------------------
export type BookResult =
  | { ok: true; booking: BookingConfirmation }
  | { ok: false; reason: "unknown_slot" | "taken" | "calendar_full" };

/** Generate a TFD-XXXX code from an unambiguous, readable alphabet. */
function newCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/O/0/1/L
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `TFD-${s}`;
}

/**
 * Book an EXACT slotId that a prior checkAvailability returned.
 *
 * Atomicity: the `UPDATE ... WHERE slotId = ? AND status = 'free'` is the single
 * gate. SQLite serializes writes, so of N concurrent callers racing the same
 * free slot, exactly one UPDATE reports rowsAffected === 1 and proceeds to insert
 * the booking; the rest see 0 and get `taken`. No slot can be double-booked.
 *
 * Order of checks:
 *   1. Calendar-full cap (bookings table) — refuse before consuming a slot.
 *   2. Slot must exist at all — otherwise `unknown_slot` (guards against the
 *      model inventing a slotId).
 *   3. Atomic claim — win the slot or report `taken`.
 */
export async function bookSlot(
  slotId: string,
  name: string,
  email: string,
): Promise<BookResult> {
  if ((await countActiveBookings()) >= MAX_ACTIVE_BOOKINGS) {
    return { ok: false, reason: "calendar_full" };
  }

  const slot = await getSlotById(slotId);
  if (!slot) return { ok: false, reason: "unknown_slot" };

  const claim = await db.execute({
    sql: "UPDATE slots SET status = 'booked' WHERE slotId = ? AND status = 'free'",
    args: [slotId],
  });
  if (claim.rowsAffected === 0) return { ok: false, reason: "taken" };

  // We own the slot. Insert the booking, retrying on the vanishingly rare code
  // collision (code is the PRIMARY KEY).
  const createdAt = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    try {
      await db.execute({
        sql: "INSERT INTO bookings (code, slotId, name, email, createdAt) VALUES (?, ?, ?, ?, ?)",
        args: [code, slotId, name, email, createdAt],
      });
      return {
        ok: true,
        booking: { code, slotId, label: slot.label, name, email },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE|constraint/i.test(msg) || attempt === 4) throw err;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error("could not allocate a unique confirmation code");
}

// --- Lookup -----------------------------------------------------------------
/** Look up a booking by its TFD-XXXX code, joined with its slot's label. */
export async function getBookingByCode(
  code: string,
): Promise<(Booking & { label: string }) | null> {
  const r = await db.execute({
    sql:
      "SELECT b.*, s.label AS label FROM bookings b " +
      "JOIN slots s ON s.slotId = b.slotId WHERE b.code = ?",
    args: [code],
  });
  return (rows<Booking & { label: string }>(r)[0] as (Booking & { label: string }) | undefined) ?? null;
}
