// `Env` is generated globally by `wrangler types` (worker-configuration.d.ts)
// from the wrangler.jsonc bindings + .dev.vars secrets. This file holds the
// app-level shapes that aren't bindings.

// What the OAuth layer + Google handler attach to each MCP session.
export interface UserProps {
  userId: string; // Google sub (stable) — the tenancy key
  email: string;
  name?: string;
  [k: string]: unknown;
}

// Per-user resource limits (the "whatever for the rest" defaults).
export const LIMITS = {
  maxConcurrentSessions: 3,
  maxProfiles: 10,
  idleTimeout: "20m",
} as const;

// Tenancy key for a (user, profile) browser. The DO id derived from this is
// unguessable across users, and gives one-live-session-per-(user,profile).
export function sessionKey(userId: string, profile: string): string {
  return `${userId}:${profile}`;
}

// R2 prefix scoping — a user only ever reads/writes under their own prefix.
export function profileKey(userId: string, profile: string): string {
  return `${userId}/${profile}/profile.tar.gz`;
}
