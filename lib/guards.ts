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
import {
  PER_IP_LIMIT,
  WINDOW_MS,
  PER_IP_DAILY_CAP,
  DAILY_MODEL_CALLS,
} from "./config";

// --- In-memory, per-instance state ------------------------------------------
// NOTE: every counter below lives in module-scope memory — one copy per server
// process. On serverless (Vercel) each instance has its own copy and instances
// come and go, so these limits are PER-INSTANCE best-effort, not a global
// guarantee. They blunt casual abuse; the hard backstop is the provider-side
// free-tier quota, which physically cannot be exceeded. (DECISIONS.md #8.)
const ipHits = new Map<string, number[]>(); // ip -> recent request timestamps (ms)
const ipDaily = new Map<string, { day: string; count: number }>(); // ip -> daily requests
const modelBudget = { day: utcDay(), count: 0 }; // global daily model-call tally

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/**
 * The caller's IP, resolved so it can't be trivially spoofed to mint fresh rate-
 * limit buckets. On Vercel `x-real-ip` is set by the platform to the true peer
 * address and is not client-controllable, so it wins. Otherwise fall back to the
 * RIGHTMOST `x-forwarded-for` hop (the one appended by the closest trusted proxy;
 * the leftmost is whatever the client sent and is spoofable). Else "unknown".
 */
export function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
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
  message: "The demo is cooling down. Try again in a minute.",
};

const DAILY_LIMIT_REACHED: GuardVerdict = {
  ok: false,
  status: 429,
  error: "daily_limit",
  message: "You've reached today's demo limit. Come back tomorrow.",
};

/**
 * Per-IP rate limits: a short sliding window (burst control) AND a per-IP daily
 * cap (one visitor can't monopolise the shared demo). A request is recorded
 * against both only when allowed through, so a blocked caller burns nothing.
 * This does NOT touch the global model-call budget — that is metered per model
 * call (see recordModelCall), not per agent request.
 */
export function checkRateLimits(ip: string, now = Date.now()): GuardVerdict {
  const today = utcDay();

  // Opportunistic bound: sweep stale entries once a map grows large, so entries
  // for IPs that never come back don't linger forever.
  if (ipHits.size > 1000) {
    const staleCutoff = now - WINDOW_MS;
    for (const [key, hits] of ipHits) {
      if (hits.every((t) => t <= staleCutoff)) ipHits.delete(key);
    }
  }
  if (ipDaily.size > 1000) {
    for (const [key, d] of ipDaily) {
      if (d.day !== today) ipDaily.delete(key);
    }
  }

  // 1. Per-IP sliding window over the last WINDOW_MS (burst control).
  const cutoff = now - WINDOW_MS;
  const recent = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (recent.length >= PER_IP_LIMIT) {
    ipHits.set(ip, recent); // keep the pruned window so it decays correctly
    return COOLING_DOWN;
  }

  // 2. Per-IP daily cap.
  const d = ipDaily.get(ip);
  const dayCount = d && d.day === today ? d.count : 0;
  if (dayCount >= PER_IP_DAILY_CAP) return DAILY_LIMIT_REACHED;

  // Allowed — record the hit against both per-IP counters.
  recent.push(now);
  ipHits.set(ip, recent);
  ipDaily.set(ip, { day: today, count: dayCount + 1 });
  return { ok: true };
}

/** Run the abuse guards for a request. */
export function runGuards(req: Request): GuardVerdict {
  return checkRateLimits(clientIp(req));
}

// --- Global daily model-call budget -----------------------------------------
/** Friendly spoken notice when the day's model-call budget is spent. */
export const DEMO_RESTING_MESSAGE =
  "The demo has reached today's usage limit. Check back tomorrow.";

function rollModelDay(): void {
  const today = utcDay();
  if (modelBudget.day !== today) {
    modelBudget.day = today;
    modelBudget.count = 0;
  }
}

/** True while the global model-call budget for today still has room. */
export function modelBudgetAvailable(): boolean {
  rollModelDay();
  return modelBudget.count < DAILY_MODEL_CALLS;
}

/**
 * Record ONE model call against today's global budget. Wired into runAgent's
 * per-step callback so every LLM call (up to MAX_STEPS per agent request) is
 * counted, not just the request. A request already in flight may push the tally
 * a few calls past the budget; that's why DAILY_MODEL_CALLS sits well under the
 * provider's hard daily quota.
 */
export function recordModelCall(): void {
  rollModelDay();
  modelBudget.count += 1;
}

// --- Reset authorization (see app/api/reset) --------------------------------
/**
 * Whether a /api/reset request is allowed to wipe and reseed the shared calendar.
 * When RESET_SECRET is set (production) the caller must supply a matching
 * `?secret=` query param or `x-reset-secret` header. When it is unset (local
 * dev) reset is open. Rate limits still apply either way.
 */
export function resetAuthorized(req: Request): boolean {
  const secret = process.env.RESET_SECRET;
  if (!secret) return true;
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ?? req.headers.get("x-reset-secret");
  return provided === secret;
}
