// Loads .env.local (and the other Next env files) into process.env for the
// standalone tsx scripts, the same way `next dev` / `next build` do.
//
// Import this BEFORE any module that reads env at import time — notably lib/db.ts,
// which builds the libSQL client from TURSO_* (or the eval/smoke DEMO_DB_URL
// override) the moment it is evaluated. ES module imports run in source order, so
// importing this file first guarantees the values are present in time.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
