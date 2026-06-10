// Registry of all AgentRuntime implementations. Adding a new runtime is:
//   1. drop a file in this folder that exports an AgentRuntime,
//   2. import + register here,
//   3. extend SessionRuntime in sessions.ts (or use a string id).
//
// Future: Codex goes here, remote runners (Docker / cloud) go here too —
// each just satisfies the AgentRuntime interface; the transport is internal
// to that runtime's implementation.

import type { AgentRuntime } from "../agent-runtime";
import { claudeRuntime } from "./claude";
import { geminiRuntime } from "./gemini";
import { cloudRuntime } from "./cloud";

export const RUNTIMES: Record<string, AgentRuntime> = {
  [claudeRuntime.id]: claudeRuntime,
  [geminiRuntime.id]: geminiRuntime,
  [cloudRuntime.id]: cloudRuntime,
};

export function getRuntime(id: string): AgentRuntime {
  const r = RUNTIMES[id];
  if (!r) throw new Error(`Unknown agent runtime: "${id}". Registered: ${Object.keys(RUNTIMES).join(", ")}`);
  return r;
}

export { claudeRuntime, geminiRuntime, cloudRuntime };
