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

/** libSQL connection URL. Falls back to a local SQLite file for zero-config dev. */
export const DB_URL =
  process.env.DEMO_DB_URL ?? process.env.TURSO_DATABASE_URL ?? "file:local.db";

/** Auth token — only needed for a hosted Turso database, absent for local files. */
const DB_AUTH_TOKEN = process.env.DEMO_DB_URL
  ? undefined // isolated local file: never attach a Turso token
  : process.env.TURSO_AUTH_TOKEN;

export const db: Client = createClient(
  DB_AUTH_TOKEN ? { url: DB_URL, authToken: DB_AUTH_TOKEN } : { url: DB_URL },
);
