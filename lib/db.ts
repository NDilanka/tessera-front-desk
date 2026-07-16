// Single libSQL client for the whole app.
//
// Local dev needs no account: the default URL is a plain SQLite file (`local.db`)
// created by `npm run seed`. In production, set TURSO_DATABASE_URL (and
// TURSO_AUTH_TOKEN for a hosted Turso database) and the same code talks to Turso
// over the network — libSQL speaks both.
//
// DEMO_DB_URL is an INTERNAL override used only by the eval and smoke scripts to
// point at an isolated throwaway file (.eval.db / .smoke.db). It takes precedence
// over TURSO_* so those harnesses can NEVER touch a hosted Turso database, even
// when TURSO_DATABASE_URL is set in the environment. It is not a user-facing knob
// and is intentionally absent from env.example.
import { createClient, type Client } from "@libsql/client";

/**
 * Resolve the libSQL connection URL. Precedence:
 *   1. DEMO_DB_URL         — internal eval/smoke override (isolated throwaway file).
 *   2. TURSO_DATABASE_URL  — hosted Turso: a persistent, SHARED calendar (recommended for prod).
 *   3. On Vercel with neither set — `file:/tmp/front-desk.db`. The app directory
 *      is read-only on Vercel, so the zero-config `file:local.db` default would
 *      make every booking 500. `/tmp` is writable but PER-INSTANCE and EPHEMERAL:
 *      each serverless instance gets its own calendar, auto-seeded on first
 *      access (see ensureSeeded), and bookings may not survive between requests.
 *      Fine for a demo; set TURSO_* for a real shared calendar.
 *   4. Otherwise (local dev) — `file:local.db`, created by `npm run seed`.
 */
function resolveDbUrl(): string {
  if (process.env.DEMO_DB_URL) return process.env.DEMO_DB_URL;
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  if (process.env.VERCEL) {
    console.warn(
      "[db] No TURSO_DATABASE_URL set on Vercel — using ephemeral file:/tmp/front-desk.db. " +
        "This is a per-instance, auto-seeded calendar; bookings may not persist between requests. " +
        "Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN for a persistent shared calendar.",
    );
    return "file:/tmp/front-desk.db";
  }
  return "file:local.db";
}

/** libSQL connection URL. Falls back to a local SQLite file for zero-config dev. */
export const DB_URL = resolveDbUrl();

/** Auth token — only needed for a hosted Turso database, absent for local files. */
const DB_AUTH_TOKEN = process.env.DEMO_DB_URL
  ? undefined // isolated local file: never attach a Turso token
  : process.env.TURSO_AUTH_TOKEN;

export const db: Client = createClient(
  DB_AUTH_TOKEN ? { url: DB_URL, authToken: DB_AUTH_TOKEN } : { url: DB_URL },
);

// --- First-access seeding ----------------------------------------------------
let seededPromise: Promise<void> | null = null;

/**
 * Ensure the calendar tables exist and hold slots before the app reads them.
 *
 * On an ephemeral serverless database (see resolveDbUrl case 3) a fresh instance
 * starts with NO tables, so the first `/api/agent` request would otherwise fail.
 * This seeds the calendar on first access. Memoized per instance, so the cost is
 * a single COUNT query on every subsequent call. When Turso is configured and
 * already seeded, this is a cheap no-op; it only seeds when the calendar is
 * missing/empty (it never drops a populated calendar).
 */
export async function ensureSeeded(): Promise<void> {
  if (!seededPromise) {
    seededPromise = (async () => {
      try {
        const r = await db.execute("SELECT COUNT(*) AS n FROM slots");
        if (Number((r.rows[0] as unknown as { n: number }).n) > 0) return;
      } catch {
        // slots table doesn't exist yet — fall through and seed.
      }
      // Dynamic import breaks the db <-> seed module cycle at eval time.
      const { runSeed } = await import("./seed");
      const counts = await runSeed();
      console.warn(
        `[db] Auto-seeded ephemeral calendar (${DB_URL}): ${counts.slots} slots, ${counts.free} free.`,
      );
    })().catch((err) => {
      seededPromise = null; // let a later request retry a failed seed
      throw err;
    });
  }
  return seededPromise;
}
