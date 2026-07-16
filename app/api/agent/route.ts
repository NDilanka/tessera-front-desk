// Front-desk agent API — one request per spoken turn.
//
// Flow: validate shape/size → abuse guards → key check → runAgent → JSON reply.
// The server is STATELESS: the client posts the full transcript each turn and
// gets back { text, booking? }. `text` is spoken aloud; `booking` (present only
// when a booking succeeded this turn) populates the confirmation card.
import { runAgent } from "@/lib/agent";
import { agentConfigured, overTurnCap } from "@/lib/config";
import { runGuards } from "@/lib/guards";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject oversized conversations before they reach the model. */
const MAX_MESSAGES = 60; // ≥ MAX_TURNS user turns + their assistant replies
const MAX_TOTAL_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 2_000;

interface AgentRequestBody {
  messages?: unknown;
}

function isChatMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  return (
    (r.role === "user" || r.role === "assistant") &&
    typeof r.content === "string"
  );
}

export async function POST(req: Request) {
  // Abuse guards run BEFORE anything else so a flood can't run up the quota.
  const verdict = runGuards(req);
  if (!verdict.ok) {
    return Response.json(
      { error: verdict.error, message: verdict.message },
      { status: verdict.status },
    );
  }

  let body: AgentRequestBody;
  try {
    body = (await req.json()) as AgentRequestBody;
  } catch {
    return Response.json(
      { error: "bad_request", message: "Invalid JSON body." },
      { status: 400 },
    );
  }

  // Validate the transcript shape.
  const raw = body?.messages;
  if (!Array.isArray(raw) || !raw.every(isChatMessage)) {
    return Response.json(
      { error: "bad_request", message: "Expected { messages: {role, content}[] }." },
      { status: 400 },
    );
  }
  const messages = raw as ChatMessage[];

  // Size caps.
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  if (
    messages.length > MAX_MESSAGES ||
    totalChars > MAX_TOTAL_CHARS ||
    messages.some((m) => m.content.length > MAX_MESSAGE_CHARS)
  ) {
    return Response.json(
      { error: "too_large", message: "This conversation is too long. Please reset the demo." },
      { status: 413 },
    );
  }

  // Server-side turn cap (mirrors the client's 20-turn cap).
  if (overTurnCap(messages)) {
    return Response.json(
      {
        error: "session_limit",
        message: "Session limit reached — please reset the demo to start a new booking.",
      },
      { status: 429 },
    );
  }

  // No key yet? Friendly notice instead of a crash — the demo environment may
  // not have a key set, and the UI renders `message` as a spoken/printed notice.
  if (!agentConfigured()) {
    return Response.json(
      {
        error: "no_api_key",
        message:
          "The booking assistant isn't configured yet. Add a GEMINI_API_KEY (free at aistudio.google.com/apikey) to enable it.",
      },
      { status: 503 },
    );
  }

  try {
    const { text, booking } = await runAgent(messages);
    return Response.json({ text, booking: booking ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      { error: "agent_error", message: `The assistant hit an error: ${message}` },
      { status: 500 },
    );
  }
}
