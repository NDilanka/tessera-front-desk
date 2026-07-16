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

/**
 * Canonicalize a slotId the model may have re-formatted while echoing it back.
 * A slotId is a bare ISO minute ("2026-07-20T10:00"), and weaker models like to
 * "helpfully" normalize it — appending seconds/`Z` ("...T10:00:00Z"), swapping
 * the `T` for a dash ("2026-07-20-1000"), etc. We reconstruct the canonical form
 * from the date + hour it contains so a real, offered slot is still matched.
 *
 * This does NOT weaken the anti-invention guard (DECISIONS.md #2): the result is
 * only ever looked up against a slot that actually exists, and booking still
 * requires it to be free. A fully made-up id (no YYYY-MM-DD, or a date with no
 * matching slot) resolves to nothing and is rejected exactly as before.
 *
 * Returns the canonical `YYYY-MM-DDTHH:00`, or null if no date+hour is present.
 */
export function canonicalSlotId(raw: string): string | null {
  const dateMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dateMatch) return null;
  const [, y, mo, d] = dateMatch;
  const rest = raw.slice((dateMatch.index ?? 0) + dateMatch[0].length);
  const digits = rest.match(/\d+/);
  if (!digits) return null;
  const run = digits[0];
  // A 3–4 digit run is HMM/HHMM (drop the trailing minutes); 1–2 digits is the hour.
  const hour = run.length >= 3 ? Number(run.slice(0, run.length - 2)) : Number(run);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return `${y}-${mo}-${d}T${String(hour).padStart(2, "0")}:00`;
}

/** Look up a slot by its exact id, falling back to the canonicalized form. */
async function resolveSlot(slotId: string): Promise<Slot | null> {
  const exact = await getSlotById(slotId);
  if (exact) return exact;
  const canonical = canonicalSlotId(slotId);
  if (canonical && canonical !== slotId) return getSlotById(canonical);
  return null;
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

  const slot = await resolveSlot(slotId);
  if (!slot) return { ok: false, reason: "unknown_slot" };
  // Book against the slot's real id, not whatever variant the model echoed.
  slotId = slot.slotId;

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
