// Abuse guards for the public demo. Checked at the API boundary BEFORE any model
// call runs, so a burst of traffic can't run up the (free-tier) quota or get the
// key throttled.
//
// IMPORTANT: the rate-limit and daily-cap state below lives in module-scope Maps
// — i.e. in the memory of a single server process. On a serverless host (Vercel)
// each instance has its own copy and instances come and go, so these limits are
// **per-instance best-effort**, not a global guarantee. They exist to blunt
// casual abuse and accidental loops; the real backstop is the provider-side
// free-tier quota, which physically cannot be exceeded.
import { PER_IP_LIMIT, WINDOW_MS, DAILY_CAP } from "./config";

// --- In-memory, per-instance state ------------------------------------------
const ipHits = new Map<string, number[]>(); // ip -> recent request timestamps (ms)
const daily = { day: utcDay(), count: 0 }; // resets when the UTC day rolls over

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Read the caller's IP from the first hop of x-forwarded-for; else "unknown". */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string };

const COOLING_DOWN: GuardVerdict = {
  ok: false,
  status: 429,
  error: "cooling_down",
  message: "The demo is cooling down — try again in a minute.",
};

/**
 * Check the global daily cap and the per-IP sliding window. A served request is
 * recorded against both counters only when it is allowed through, so a blocked
 * caller doesn't burn the global daily budget.
 */
export function checkRateLimits(ip: string, now = Date.now()): GuardVerdict {
  // 1. Global daily cap (UTC-day kill-switch).
  const today = utcDay();
  if (daily.day !== today) {
    daily.day = today;
    daily.count = 0;
  }
  if (daily.count >= DAILY_CAP) return COOLING_DOWN;

  // Opportunistic bound: sweep stale IP entries once the map grows large, so
  // entries for IPs that never come back don't linger forever.
  if (ipHits.size > 1000) {
    const staleCutoff = now - WINDOW_MS;
    for (const [key, hits] of ipHits) {
      if (hits.every((t) => t <= staleCutoff)) ipHits.delete(key);
    }
  }

  // 2. Per-IP sliding window over the last WINDOW_MS.
  const cutoff = now - WINDOW_MS;
  const recent = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= PER_IP_LIMIT) {
    ipHits.set(ip, recent); // keep the pruned window so it decays correctly
    return COOLING_DOWN;
  }

  // Allowed — record the hit against both counters.
  recent.push(now);
  ipHits.set(ip, recent);
  daily.count += 1;
  return { ok: true };
}

/** Run the abuse guards for a request. */
export function runGuards(req: Request): GuardVerdict {
  return checkRateLimits(clientIp(req));
}
