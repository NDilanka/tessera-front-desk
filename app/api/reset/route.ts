// Demo-reset endpoint — reseeds the calendar to a fresh rolling set of open
// slots and wipes every booking, so the public demo returns to a known-good
// state. Shares lib/seed.ts with `npm run seed`.
//
// Rate-limited by the same per-IP / per-day guards as the agent route so it
// can't be hammered to churn the database.
import { runSeed } from "@/lib/seed";
import { runGuards, resetAuthorized } from "@/lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const verdict = runGuards(req);
  if (!verdict.ok) {
    return Response.json(
      { error: verdict.error, message: verdict.message },
      { status: verdict.status },
    );
  }

  // When RESET_SECRET is configured (production), a stranger can't wipe the
  // shared calendar: require a matching ?secret= / x-reset-secret. Unset locally.
  if (!resetAuthorized(req)) {
    return Response.json(
      { error: "forbidden", message: "This demo reset is protected." },
      { status: 403 },
    );
  }

  try {
    const counts = await runSeed();
    return Response.json({ ok: true, reseeded: counts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { ok: false, error: "seed_failed", message },
      { status: 500 },
    );
  }
}
