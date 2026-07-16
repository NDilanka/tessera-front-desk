// Database schema as plain SQL. Applied by `npm run seed` (scripts/seed.ts), the
// eval/smoke harnesses, and the demo-reset route. Kept here so the shape of the
// data lives in one obvious place.
//
// Two tables:
//   - slots:    the demo calendar. `status` is the atomic booking gate — a
//               conditional UPDATE ... WHERE status='free' is what guarantees a
//               slot is handed to exactly one booker (see lib/queries.ts).
//   - bookings: one row per confirmed booking, keyed by the TFD-XXXX code the
//               customer is given. `slotId` references the slot it consumed.

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS slots (
    slotId  TEXT PRIMARY KEY,   -- ISO minute, e.g. "2026-07-20T10:00"
    label   TEXT NOT NULL,      -- human label, e.g. "Mon Jul 20, 10:00 AM"
    date    TEXT NOT NULL,      -- YYYY-MM-DD, for day filtering
    status  TEXT NOT NULL       -- free | booked
  )`,

  `CREATE TABLE IF NOT EXISTS bookings (
    code       TEXT PRIMARY KEY,                    -- TFD-XXXX
    slotId     TEXT NOT NULL REFERENCES slots(slotId),
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    createdAt  TEXT NOT NULL                        -- ISO 8601
  )`,
];

/** Tables in dependency-safe drop order (children before parents). */
export const TABLE_NAMES = ["bookings", "slots"] as const;
