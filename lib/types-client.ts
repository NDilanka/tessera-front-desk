// Client-only types for the voice UI state machine. Kept separate from lib/types
// (which the server and DB layer share) so the client vocabulary stays distinct.

/** The half-duplex state machine: idle → listening → thinking → speaking → idle. */
export type AgentState = "idle" | "listening" | "thinking" | "speaking";
