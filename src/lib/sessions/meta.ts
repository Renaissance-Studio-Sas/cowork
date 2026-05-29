// meta.json persistence for live sessions. All writes go through
// updateMeta() which serializes per-session writes (to avoid two concurrent
// read-modify-writes producing a corrupted JSON) and writes atomically via
// .tmp + rename.

import fs from "node:fs/promises";
import path from "node:path";
import { getProject, PROJECTS_DIR } from "../fs";
import type { SessionState } from "../session-state-machine";
import type { RuntimeSession } from "./types";

// Resolve the directory holding meta.json for (project, task, session).
// Shared between updateMeta() (the locked read-modify-write path) and
// readMetaRaw() (the lock-free probe).
async function resolveSessionDir(
  projectSlug: string,
  taskSlug: string,
  sessionId: string,
): Promise<string | null> {
  const project = await getProject(projectSlug);
  if (!project) return null;
  if (!taskSlug) {
    return path.join(PROJECTS_DIR, project.folderName, "sessions", sessionId);
  }
  const task = project.tasks.find((t) => t.slug === taskSlug);
  if (!task) return null;
  return path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", sessionId);
}

// Per-session mutex queue for meta.json updates. Without this, two
// setState() calls in quick succession (very common: running → idle → stopped
// over a few hundred ms) trigger two concurrent persistSessionState calls,
// each doing read-modify-write on the same file. We've observed the resulting
// file corruption in the wild: the shorter write's `}\n` ends up overlaid on
// top of the longer write's content, leaving JSON that won't parse. That
// blocks restoreSession and the session becomes unrecoverable across server
// restarts ("session not found or failed to resume").
const metaWriteQueue = new Map<string, Promise<void>>();

// Read-modify-write meta.json safely:
// - Serialized per-session: concurrent updateMeta calls for the same session
//   are queued, so reader/writer cycles never interleave.
// - Atomic on the file system: write to a sibling .tmp file and rename, so
//   a crash or process kill mid-write never leaves a half-written meta.json.
export async function updateMeta(
  s: RuntimeSession,
  mutate: (meta: Record<string, unknown>) => void,
): Promise<void> {
  const prev = metaWriteQueue.get(s.id) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const project = await getProject(s.projectSlug);
      if (!project) return;

      let sessionDir: string;
      if (!s.taskSlug) {
        sessionDir = path.join(PROJECTS_DIR, project.folderName, "sessions", s.id);
      } else {
        const task = project.tasks.find((t) => t.slug === s.taskSlug);
        if (!task) return;
        sessionDir = path.join(PROJECTS_DIR, project.folderName, task.folderName, "sessions", s.id);
      }

      const metaPath = path.join(sessionDir, "meta.json");
      const tmpPath = metaPath + ".tmp";
      const raw = await fs.readFile(metaPath, "utf8");
      const meta = JSON.parse(raw) as Record<string, unknown>;
      mutate(meta);
      await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2));
      await fs.rename(tmpPath, metaPath);
    } catch {
      // Best effort — meta drift gets caught by reconcileSessionsOnDisk on boot.
    }
  });
  metaWriteQueue.set(s.id, next);
  try {
    await next;
  } finally {
    // If this was the last queued write for the session, drop the entry so
    // the map doesn't accumulate forever.
    if (metaWriteQueue.get(s.id) === next) metaWriteQueue.delete(s.id);
  }
}

// Persist the SDK session ID to meta.json so the session can be resumed
// after server restart.
export async function persistSdkSessionId(s: RuntimeSession): Promise<void> {
  await updateMeta(s, (meta) => {
    meta.sdkSessionId = s.sdkSessionId;
  });
}

// Persist the next-server worker PID that currently owns this session's
// in-process AgentQuery. Read by ownership checks (auto-resume, resume on
// sendInput) to detect sibling workers that own the session — without this,
// a request landing on a non-owning worker would spawn a duplicate SDK
// against the same on-disk transcript. Cleared automatically by
// persistSessionState when the session transitions to stopped/error.
export async function persistOwnerPid(s: RuntimeSession): Promise<void> {
  await updateMeta(s, (meta) => { meta.ownerPid = process.pid; });
}

// Lightweight read of a session's meta.json — no per-session lock, no
// RuntimeSession needed. Used by the ownership probe (we only need
// ownerPid); going through updateMeta would deadlock against an in-flight
// write.
export async function readMetaRaw(
  projectSlug: string,
  taskSlug: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const sessionDir = await resolveSessionDir(projectSlug, taskSlug, sessionId);
  if (!sessionDir) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDir, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

// Persist the final state to meta.json for recovery after server restart.
// Terminal states ("stopped", "error") drop the ownerPid too — there's no
// live AgentQuery anymore, so the next caller is free to claim the session.
export async function persistSessionState(s: RuntimeSession, state: SessionState): Promise<void> {
  await updateMeta(s, (meta) => {
    meta.finalState = state;
    meta.lastActivity = s.lastActivity.toISOString();
    if (s.completedAt) {
      meta.completedAt = s.completedAt.toISOString();
    }
    if (s.seenAt) {
      meta.seenAt = s.seenAt.toISOString();
    }
    if (state === "stopped" || state === "error") {
      delete meta.ownerPid;
    }
  });
}

// Persist whether the session is currently parked on a user decision
// (pending permission / question / completion). The boot-time auto-resume
// pass reads this so it can skip sessions that were waiting for the user —
// otherwise it would push a "[Server restarted...]" prompt into them, blowing
// away the parked tool call.
export async function persistPendingPromptFlag(s: RuntimeSession): Promise<void> {
  const hasPendingPrompt =
    s.pendingPermissions.size > 0
    || (s.pendingQuestions?.size ?? 0) > 0
    || (s.pendingCompletions?.size ?? 0) > 0;
  await updateMeta(s, (meta) => {
    if (hasPendingPrompt) meta.hasPendingPrompt = true;
    else delete meta.hasPendingPrompt;
  });
}
