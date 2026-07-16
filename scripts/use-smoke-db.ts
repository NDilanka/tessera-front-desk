// Point the libSQL client at an isolated throwaway file for the smoke test.
// Imported FIRST (before anything that pulls lib/db.ts) so DEMO_DB_URL is set
// before the client is constructed. The smoke test runs fully offline against
// this file and never touches Turso.
process.env.DEMO_DB_URL = "file:.smoke.db";
