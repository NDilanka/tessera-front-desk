// Point the libSQL client at an isolated throwaway file for the eval. Imported
// FIRST (before anything that pulls lib/db.ts) so DEMO_DB_URL is set before the
// client is constructed. This guarantees the eval NEVER touches a hosted Turso
// database, even if TURSO_DATABASE_URL is present in the environment.
process.env.DEMO_DB_URL = "file:.eval.db";
