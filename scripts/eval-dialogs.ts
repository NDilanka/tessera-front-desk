// `npm run eval` — multi-turn conversation eval for the booking agent.
//
// Each scripted dialog in data/eval-dialogs.json is run as TEXT through the SAME
// runAgent() the API route uses, against an isolated, freshly-seeded SQLite file
// (.eval.db — NEVER Turso; see use-eval-db.js, imported first). User turns are
// fixed; the model drives the tools. For every dialog we assert:
//   (a) the expected tool-call SEQUENCE occurred (subsequence on tool names,
//       plus optional key-arg checks), and
//   (b) the final DATABASE STATE matches (number of bookings).
//
// Primary metric: task-completion rate — gate ≥80% (12/15), non-zero exit below.
// Secondary: tool-sequence accuracy. Pacing: ~7s between turns on the Gemini free
// tier (~10 RPM). Needs GEMINI_API_KEY (or GROQ_API_KEY); absent → pending exit.
import "./use-eval-db.js"; // MUST be first: sets DEMO_DB_URL before lib/db loads
import "./load-env.js";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runAgent, type ToolCallRecord } from "../lib/agent.js";
import { runSeed } from "../lib/seed.js";
import { getOpenSlots, countActiveBookings } from "../lib/queries.js";
import { db } from "../lib/db.js";
import { agentConfigured, resolveAgent } from "../lib/config.js";
import type { ChatMessage } from "../lib/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIALOGS_PATH = path.resolve(__dirname, "..", "data", "eval-dialogs.json");

/** Task-completion rate must be at least this for the eval to succeed. */
const PASS_THRESHOLD = 0.8;
/** Inter-turn delay on the Gemini free tier (~10 RPM). */
// A single turn can burst up to MAX_STEPS (6) back-to-back model calls with no
// pacing between steps, and the free-tier window is ~20 requests/min (measured
// on gemini-3.5-flash, 2026-07-16). 22s between turns keeps the worst-case
// burst rate under the window: 6 calls / 22s ≈ 16/min.
const INTER_TURN_DELAY_MS = 22_000;

interface ArgCheck {
  tool: string;
  arg: string;
  valueIncludes: string;
}
interface EvalDialog {
  id: string;
  category: string;
  description: string;
  turns: string[];
  expectSubsequence: string[];
  expectBookings: number;
  expectArgs?: ArgCheck[];
  seedBooking?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Debug knobs (opt-in; no effect on a normal `npm run eval`) -------------
// Run a subset:  npm run eval -- --only=hp-all-upfront,taken-friday-alt
//   (or env EVAL_ONLY="id1,id2"). Print full per-turn transcripts with tool
// calls, args, and results:  npm run eval -- --verbose  (or EVAL_VERBOSE=1).
const ARGV = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = ARGV.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}
const ONLY_IDS = (flagValue("only") ?? process.env.EVAL_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const VERBOSE = ARGV.includes("--verbose") || Boolean(process.env.EVAL_VERBOSE);

function logTurn(userTurn: string, replyText: string, turnCalls: ToolCallRecord[]) {
  console.log(`    > user: ${userTurn}`);
  for (const c of turnCalls) {
    console.log(
      `      ⚙ ${c.name}(${JSON.stringify(c.args)}) -> ${JSON.stringify(c.result)}`,
    );
  }
  console.log(`    < agent: ${replyText}`);
}

/** Is `sub` an in-order subsequence of `seq`? */
function isSubsequence(sub: string[], seq: string[]): boolean {
  let i = 0;
  for (const name of seq) {
    if (i < sub.length && name === sub[i]) i += 1;
  }
  return i === sub.length;
}

function argChecksPass(checks: ArgCheck[] | undefined, calls: ToolCallRecord[]): boolean {
  if (!checks || checks.length === 0) return true;
  return checks.every((c) =>
    calls.some(
      (call) =>
        call.name === c.tool &&
        String(call.args[c.arg] ?? "")
          .toUpperCase()
          .includes(c.valueIncludes.toUpperCase()),
    ),
  );
}

/** Seed a known booking (code TFD-DEMO) onto the first free slot, for lookup tests. */
async function seedKnownBooking(): Promise<void> {
  const [slot] = await getOpenSlots(undefined, 1);
  if (!slot) throw new Error("no free slot to seed a lookup booking");
  await db.execute({
    sql: "UPDATE slots SET status = 'booked' WHERE slotId = ?",
    args: [slot.slotId],
  });
  await db.execute({
    sql: "INSERT INTO bookings (code, slotId, name, email, createdAt) VALUES (?, ?, ?, ?, ?)",
    args: ["TFD-DEMO", slot.slotId, "Existing Caller", "existing@caller.com", new Date().toISOString()],
  });
}

async function main() {
  if (!agentConfigured()) {
    console.log(
      "EVAL PENDING — no model key in the environment.\n" +
        "This eval calls a live LLM to score multi-turn tool use. Add a free\n" +
        "GEMINI_API_KEY (https://aistudio.google.com/apikey) to .env.local and\n" +
        "re-run `npm run eval`. Skipping for now (not a failure).",
    );
    process.exit(0);
  }

  const allDialogs = JSON.parse(await fs.readFile(DIALOGS_PATH, "utf-8")) as EvalDialog[];
  // Preserve original 1-based numbering even when running a subset.
  const numbered = allDialogs.map((d, i) => ({ d, n: i + 1 }));
  const selected = ONLY_IDS.length
    ? numbered.filter((x) => ONLY_IDS.includes(x.d.id))
    : numbered;
  if (ONLY_IDS.length) {
    console.log(`(subset: ${selected.map((x) => x.d.id).join(", ") || "none matched"})`);
  }
  const { modelId, provider } = resolveAgent();
  const paced = provider === "google";

  console.log(
    `Running ${selected.length} dialogs against ${modelId} (provider: ${provider})` +
      (paced ? ` [free-tier pacing: ${INTER_TURN_DELAY_MS / 1000}s between turns]` : "") +
      "\n",
  );

  let passed = 0;
  let sequenceOk = 0;
  let firstCall = true;
  const rows: string[] = [];

  for (const { d: dialog, n } of selected) {
    await runSeed();
    if (dialog.seedBooking) await seedKnownBooking();

    const transcript: ChatMessage[] = [];
    const calls: ToolCallRecord[] = [];
    let errored = "";

    if (VERBOSE) console.log(`\n── #${String(n).padStart(2, "0")} ${dialog.id} [${dialog.category}] ──`);
    for (const userTurn of dialog.turns) {
      if (paced && !firstCall) await sleep(INTER_TURN_DELAY_MS);
      firstCall = false;
      transcript.push({ role: "user", content: userTurn });
      try {
        const res = await runAgent(transcript);
        transcript.push({ role: "assistant", content: res.text || "(no reply)" });
        calls.push(...res.toolCalls);
        if (VERBOSE) logTurn(userTurn, res.text || "(no reply)", res.toolCalls);
      } catch (err) {
        errored = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    const names = calls.map((c) => c.name);
    const subOk = isSubsequence(dialog.expectSubsequence, names);
    const argOk = argChecksPass(dialog.expectArgs, calls);
    const bookings = await countActiveBookings();
    const stateOk = bookings === dialog.expectBookings;
    const pass = !errored && subOk && argOk && stateOk;

    if (subOk && argOk) sequenceOk += 1;
    if (pass) passed += 1;

    rows.push(
      `${pass ? "PASS" : "FAIL"}  #${String(n).padStart(2, "0")}  [${dialog.category}]  ${dialog.id}\n` +
        `        tools: [${names.join(", ") || "—"}]  expect⊇[${dialog.expectSubsequence.join(", ") || "—"}]` +
        `  bookings: ${bookings}/${dialog.expectBookings}` +
        (errored ? `  ERROR: ${errored}` : "") +
        (!subOk ? "  ✗seq" : "") +
        (!argOk ? "  ✗args" : "") +
        (!stateOk ? "  ✗state" : ""),
    );
  }

  console.log(rows.join("\n"));

  const n = selected.length;
  const completion = (passed / n) * 100;
  const seqAccuracy = (sequenceOk / n) * 100;
  console.log(
    `\ntool-sequence accuracy: ${sequenceOk}/${n} (${seqAccuracy.toFixed(1)}%)`,
  );
  console.log(`task-completion rate:   ${passed}/${n} (${completion.toFixed(1)}%)`);

  if (ONLY_IDS.length) {
    // Subset/debug run — the ≥80% gate only applies to the full 15-dialog suite.
    console.log("\n(subset run — gate not evaluated)");
    process.exit(0);
  }
  if (passed / n < PASS_THRESHOLD) {
    console.error(
      `\nFAIL: task-completion ${completion.toFixed(1)}% is below the ${PASS_THRESHOLD * 100}% gate.`,
    );
    process.exit(1);
  }
  console.log(`\nPASS: task-completion meets the ${PASS_THRESHOLD * 100}% gate.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
