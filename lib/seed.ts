// Deterministic seed for the Tessera front-desk demo calendar, extracted here so
// it can be shared by every caller:
//   - scripts/seed.ts        (the `npm run seed` CLI)
//   - scripts/eval-dialogs.ts / scripts/smoke-agent.ts (isolated test databases)
//   - app/api/reset/route.ts (the demo-reset endpoint)
//
// runSeed() drops and recreates both tables, then generates a rolling calendar of
// weekday slots RELATIVE TO TODAY so the demo always has fresh, in-the-future
// availability no matter when it is run. The generation is otherwise fully
// deterministic (fixed times, fixed pre-booking pattern) so the eval can reason
// about availability.
import { db } from "./db";
import { SCHEMA_STATEMENTS, TABLE_NAMES } from "./schema";

// --- Calendar shape ---------------------------------------------------------
/** Hours offered each weekday (24h). A midday gap keeps it looking real. */
const SLOT_HOURS = [10, 11, 13, 14, 15, 16];
/** How many calendar days ahead to generate (covers ~2 working weeks). */
const HORIZON_DAYS = 18;

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-07-20T10:00" — the canonical slot key echoed to bookAppointment. */
function slotId(d: Date, hour: number): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

/** "Mon Jul 20, 10:00 AM" — spoken/printed, never parsed back into a date. */
function slotLabel(d: Date, hour: number): string {
  const ampm = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${WEEKDAY[d.getDay()]} ${MONTH[d.getMonth()]} ${d.getDate()}, ${h12}:00 ${ampm}`;
}

interface SeedSlot {
  slotId: string;
  label: string;
  date: string;
  status: "free" | "booked";
}

/**
 * Build the demo slots relative to `now`. Rules:
 *   - Weekdays only (Mon–Fri), starting tomorrow, for HORIZON_DAYS.
 *   - Fridays are fully pre-booked — a reliably-nameable "that day is full" case
 *     for the "requested day unavailable → offer alternative → book" flow.
 *   - Other weekdays pre-book 11:00 and 15:00, leaving four open slots each.
 */
export function buildSlots(now = new Date()): SeedSlot[] {
  const slots: SeedSlot[] = [];
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = 1; offset <= HORIZON_DAYS; offset++) {
    const d = new Date(start);
    d.setDate(start.getDate() + offset);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const fridayFull = dow === 5;
    SLOT_HOURS.forEach((hour, i) => {
      const prebooked = fridayFull || i === 1 || i === 4; // 11:00 & 15:00 otherwise
      slots.push({
        slotId: slotId(d, hour),
        label: slotLabel(d, hour),
        date,
        status: prebooked ? "booked" : "free",
      });
    });
  }
  return slots;
}

export interface SeedCounts {
  slots: number;
  free: number;
  prebooked: number;
}

/**
 * Drop both tables, recreate the schema, and insert a freshly-generated calendar.
 * The bookings table is left empty — customer bookings append to it at runtime.
 * Returns the slot counts inserted.
 */
export async function runSeed(now = new Date()): Promise<SeedCounts> {
  for (const table of TABLE_NAMES) {
    await db.execute(`DROP TABLE IF EXISTS ${table}`);
  }
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.execute(stmt);
  }

  const slots = buildSlots(now);
  await db.batch(
    slots.map((s) => ({
      sql: "INSERT INTO slots (slotId, label, date, status) VALUES (?, ?, ?, ?)",
      args: [s.slotId, s.label, s.date, s.status],
    })),
    "write",
  );

  const free = slots.filter((s) => s.status === "free").length;
  return { slots: slots.length, free, prebooked: slots.length - free };
}
