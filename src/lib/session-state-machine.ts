/**
 * Session state machine - defines valid states and transitions.
 *
 * This module contains the state logic without any globals or side effects.
 * The main sessions.ts file imports this and uses it with its own registry.
 */

export type SessionState = "running" | "idle" | "awaiting_input" | "stopped" | "error";

/**
 * Valid state transitions:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │                                                              │
 *   │  ┌─────────┐                                                 │
 *   │  │ running │◄──────────────────────────────────────┐         │
 *   │  └────┬────┘                                       │         │
 *   │       │                                            │         │
 *   │       ▼                                            │         │
 *   │  ┌─────────────────┐     ┌────────┐     ┌─────────┐│         │
 *   │  │ awaiting_input  │────►│  idle  │────►│ stopped ││         │
 *   │  └─────────────────┘     └────────┘     └─────────┘│         │
 *   │       │                       │              │     │         │
 *   │       │                       │              │     │         │
 *   │       └───────────────────────┴──────────────┴─────┘         │
 *   │                                                              │
 *   │                          ┌───────┐                           │
 *   │                          │ error │◄──── (from any state)     │
 *   │                          └───────┘                           │
 *   │                              │                               │
 *   │                              └──────────────────────────────►│
 *   │                                     (can resume to running)  │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Key rules:
 * - "running" can go to: idle, awaiting_input, stopped, error
 * - "idle" can go to: running (resume), stopped (eviction)
 * - "awaiting_input" can go to: running (user replied), stopped, error
 * - "stopped" can go to: running (resume only)
 * - "error" can go to: running (resume only)
 */

const VALID_TRANSITIONS: Record<SessionState, Set<SessionState>> = {
  running: new Set(["idle", "awaiting_input", "stopped", "error"]),
  idle: new Set(["running", "stopped"]),
  awaiting_input: new Set(["running", "stopped", "error"]),
  stopped: new Set(["running"]),
  error: new Set(["running"]),
};

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return true; // No-op is always valid
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

/**
 * Terminal states - session is done and won't process more events
 * without explicit resumption.
 */
export function isTerminalState(state: SessionState): boolean {
  return state === "stopped" || state === "error" || state === "idle";
}

/**
 * States that indicate the session completed its work (not an error).
 */
export function isCompletedState(state: SessionState): boolean {
  return state === "idle" || state === "stopped";
}

/**
 * States that should be persisted to meta.json for recovery.
 * This includes all terminal states so the UI shows the correct state after refresh.
 */
export function shouldPersistState(state: SessionState): boolean {
  return state === "idle" || state === "error" || state === "stopped";
}

/**
 * Check if a state can be overwritten by a pumpEvents loop ending.
 *
 * When pumpEvents finishes, it tries to set "stopped". But if:
 * - The session was resumed (state is "running"), don't overwrite
 * - The session completed successfully (state is "idle"), don't overwrite
 * - The session was already stopped (by interrupt), don't overwrite
 */
export function canOverwriteWithStopped(currentState: SessionState): boolean {
  return currentState !== "idle" && currentState !== "running" && currentState !== "stopped";
}

/**
 * Determine the next state when the agent finishes a turn (result event).
 *
 * @param askedQuestion - whether the agent's last message ended with a question
 */
export function stateAfterResult(askedQuestion: boolean): SessionState {
  return askedQuestion ? "awaiting_input" : "idle";
}
