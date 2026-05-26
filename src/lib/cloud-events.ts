// Per-session event log. Two backends behind one API:
//
//   - "file" (default): the local on-disk events.jsonl that sessions.ts has
//     always used. One JSON event per line, append-only. This is what runs
//     today — the D1 platform table below isn't implemented yet.
//   - "d1": a Cloudflare D1 table on the Rowads platform (table
//     `cowork-sessions-marco`) via the storage worker. Kept ready for when the
//     platform endpoints land; flip BACKEND to "d1" to enable.
//
// Public API (backend-agnostic):
//   registerSessionLog(id, eventsFilePath)  — point the log at a file (file backend)
//   appendEvent(id, seq, event)             — fire-and-forget persist
//   flushEvents(id)                         — await pending writes
//   forgetSession(id)                       — drop in-memory state
//   readSessionEvents(id, {limit, offset})  — read back in order (offset from END)
//   deleteSessionEvents(id)                 — remove all persisted events
//
// Sequence numbers come from the caller (RuntimeSession.seq, via `seq++`). The
// file backend stores one event per line in call order; seq is carried for the
// D1 backend, where it keys idempotent (onConflict: ignore) inserts.

import fs from "node:fs";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isVisibleSDKMessage } from "@/components/chat/utils";

// D1 isn't implemented yet — default to the local file backend.
const BACKEND: "file" | "d1" = "file";

// ───────────────────────── File backend ─────────────────────────

// sessionId -> events.jsonl path. Set by registerSessionLog. Reads and writes
// both resolve the path from here, so a session must be registered before use.
const filePaths = new Map<string, string>();
// Lazily-opened append streams, keyed by sessionId.
const fileStreams = new Map<string, WriteStream>();

/** Point a session's event log at a file (file backend). Idempotent. */
export function registerSessionLog(sessionId: string, eventsFilePath: string): void {
  const prev = filePaths.get(sessionId);
  if (prev === eventsFilePath) return;
  filePaths.set(sessionId, eventsFilePath);
  // Path changed (e.g. resume after restore) — drop any stale stream so the
  // next append reopens against the new path.
  const stream = fileStreams.get(sessionId);
  if (stream) {
    stream.end();
    fileStreams.delete(sessionId);
  }
}

function fileStreamFor(sessionId: string): WriteStream | null {
  const existing = fileStreams.get(sessionId);
  if (existing) return existing;
  const p = filePaths.get(sessionId);
  if (!p) return null;
  const stream = createWriteStream(p, { flags: "a" });
  fileStreams.set(sessionId, stream);
  return stream;
}

function fileAppend(sessionId: string, event: unknown): void {
  const stream = fileStreamFor(sessionId);
  if (!stream) return; // not registered — nothing to write to
  stream.write(JSON.stringify(event) + "\n");
}

function fileForget(sessionId: string): void {
  const stream = fileStreams.get(sessionId);
  if (stream) stream.end();
  fileStreams.delete(sessionId);
  filePaths.delete(sessionId);
}

async function fileRead(
  sessionId: string,
  opts: { limit?: number; offset?: number },
): Promise<{ events: unknown[]; total: number; hasMore: boolean }> {
  const p = filePaths.get(sessionId);
  if (!p) return { events: [], total: 0, hasMore: false };
  let all: unknown[];
  try {
    const raw = await readFile(p, "utf8");
    all = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return { events: [], total: 0, hasMore: false };
  }
  // `total` is the count of VISIBLE messages (rendered as bubbles/cards/pills),
  // not raw SDK events. Tool calls collapse into a chip row and tool_result
  // echoes don't render at all — counting them made "Load older (N more)" lie
  // and produced nearly-empty initial pages on tool-heavy turns.
  const total = all.reduce<number>((n, e) => n + (isVisibleSDKMessage(e) ? 1 : 0), 0);

  if (opts.limit === undefined) return { events: all, total, hasMore: false };

  // Page is taken from the END. `offset` is event-count (matches the client's
  // `messages.length` — sum of visible + invisible events already loaded);
  // `limit` is the number of additional VISIBLE messages this page should add.
  // Walk back from where the previous page started, including every event we
  // pass through, until we've collected `limit` more visible messages.
  const offset = opts.offset ?? 0;
  const end = Math.max(0, all.length - offset);
  if (end === 0) return { events: [], total, hasMore: false };
  let i = end;
  let visibleSeen = 0;
  while (i > 0 && visibleSeen < opts.limit) {
    i--;
    if (isVisibleSDKMessage(all[i])) visibleSeen++;
  }
  // hasMore = at least one more visible message exists before this slice.
  let hasMore = false;
  for (let k = i - 1; k >= 0; k--) {
    if (isVisibleSDKMessage(all[k])) { hasMore = true; break; }
  }
  return { events: all.slice(i, end), total, hasMore };
}

async function fileDelete(sessionId: string): Promise<void> {
  const p = filePaths.get(sessionId);
  fileForget(sessionId);
  if (p) {
    try { await unlink(p); } catch { /* already gone */ }
  }
}

// ───────────────────────── D1 backend (deferred) ─────────────────────────

const TABLE = "cowork-sessions-marco";
const FLUSH_INTERVAL_MS = 100;
const FLUSH_THRESHOLD = 200;
const MAX_RETRY_ATTEMPTS = 5;

interface Credentials {
  gateway: string;
  cookie: string;
}

function loadCredentials(): Credentials {
  const credsPath = path.join(os.homedir(), ".rw", "credentials.json");
  const raw = fs.readFileSync(credsPath, "utf8");
  const file = JSON.parse(raw) as {
    defaultEnv?: string;
    envs?: Record<string, { gateway: string; cookie: string }>;
  };
  const env = file.defaultEnv ?? "production";
  const entry = file.envs?.[env];
  if (!entry?.gateway || !entry?.cookie) {
    throw new Error(
      `cloud-events: ~/.rw/credentials.json has no '${env}' env — run 'rw auth login'`,
    );
  }
  return { gateway: entry.gateway, cookie: entry.cookie };
}

let creds: Credentials | null = null;
function getCreds(): Credentials {
  if (!creds) creds = loadCredentials();
  return creds;
}

async function apiPost<T>(routePath: string, body: unknown): Promise<T> {
  const c = getCreds();
  const res = await fetch(`${c.gateway}${routePath}`, {
    method: "POST",
    headers: {
      Cookie: `__gateway_session=${c.cookie}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`cloud-events ${routePath}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface ExecResult { success: boolean; changes: number; error?: string }
interface QueryResult<R> { success: boolean; results?: R[]; error?: string }

interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  event_json: string;
}

class SessionQueue {
  private buffer: Array<{ seq: number; event: unknown }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> = Promise.resolve();

  constructor(private readonly sessionId: string) {}

  append(seq: number, event: unknown): void {
    this.buffer.push({ seq, event });
    if (this.buffer.length >= FLUSH_THRESHOLD) {
      this.scheduleFlush(0);
    } else {
      this.scheduleFlush(FLUSH_INTERVAL_MS);
    }
  }

  private scheduleFlush(delay: number): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.inflight = this.inflight.then(() => this.flush());
    }, delay);
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.inflight = this.inflight.then(() => this.flush());
    await this.inflight;
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const values = batch.map((row) => ({
      id: `${this.sessionId}#${row.seq}`,
      session_id: this.sessionId,
      seq: row.seq,
      event_json: JSON.stringify(row.event),
    }));
    let attempt = 0;
    let lastError: unknown = null;
    while (attempt < MAX_RETRY_ATTEMPTS) {
      try {
        const result = await apiPost<ExecResult>("/api/storage/tables/insert", {
          into: TABLE,
          values,
          onConflict: "ignore",
        });
        if (result.success) return;
        lastError = result.error ?? "unknown error";
      } catch (err) {
        lastError = err;
      }
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (attempt - 1), 30000)));
    }
    console.error(
      `[cloud-events] dropped ${values.length} events for session ${this.sessionId} after ${MAX_RETRY_ATTEMPTS} attempts:`,
      lastError,
    );
  }
}

const queues = new Map<string, SessionQueue>();

function getQueue(sessionId: string): SessionQueue {
  let q = queues.get(sessionId);
  if (!q) {
    q = new SessionQueue(sessionId);
    queues.set(sessionId, q);
  }
  return q;
}

async function d1Read(
  sessionId: string,
  opts: { limit?: number; offset?: number },
): Promise<{ events: unknown[]; total: number; hasMore: boolean }> {
  await getQueue(sessionId).flushNow();

  const totalResult = await apiPost<QueryResult<{ n: number }>>(
    "/api/storage/tables/query",
    {
      from: TABLE,
      select: ["COUNT(*) AS n"],
      where: { session_id: sessionId },
    },
  );
  const total = totalResult.results?.[0]?.n ?? 0;

  if (opts.limit === undefined) {
    const all = await apiPost<QueryResult<EventRow>>("/api/storage/tables/query", {
      from: TABLE,
      where: { session_id: sessionId },
      orderBy: [{ column: "seq", direction: "asc" }],
    });
    const events = (all.results ?? []).map((r) => JSON.parse(r.event_json));
    return { events, total, hasMore: false };
  }

  const offset = opts.offset ?? 0;
  const page = await apiPost<QueryResult<EventRow>>("/api/storage/tables/query", {
    from: TABLE,
    where: { session_id: sessionId },
    orderBy: [{ column: "seq", direction: "desc" }],
    limit: opts.limit,
    offset,
  });
  const rows = (page.results ?? []).slice().reverse();
  const events = rows.map((r) => JSON.parse(r.event_json));
  const hasMore = offset + rows.length < total;
  return { events, total, hasMore };
}

async function d1Delete(sessionId: string): Promise<void> {
  queues.delete(sessionId);
  await apiPost<ExecResult>("/api/storage/tables/delete", {
    deleteFrom: TABLE,
    where: { session_id: sessionId },
  });
}

// ───────────────────────── Public API (dispatch) ─────────────────────────

// Fire-and-forget append. Caller assigns seq monotonically per session. Don't
// await on the hot path; the D1 backend surfaces failures via its retry loop.
export function appendEvent(sessionId: string, seq: number, event: unknown): void {
  if (BACKEND === "d1") getQueue(sessionId).append(seq, event);
  else fileAppend(sessionId, event);
}

// Force-flush pending writes. Call before a read to avoid missing in-flight rows.
export async function flushEvents(sessionId: string): Promise<void> {
  if (BACKEND === "d1") {
    const q = queues.get(sessionId);
    if (q) await q.flushNow();
  }
  // File backend writes are appended immediately to the OS buffer; no flush.
}

// Drop the per-session in-memory state (stream/queue). Persisted events remain.
export function forgetSession(sessionId: string): void {
  if (BACKEND === "d1") queues.delete(sessionId);
  else fileForget(sessionId);
}

// Read events for one session in seq/append order (ascending). When `limit` is
// set, the page is taken from the END (offset=0 = most recent `limit`).
export async function readSessionEvents(
  sessionId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ events: unknown[]; total: number; hasMore: boolean }> {
  return BACKEND === "d1" ? d1Read(sessionId, opts) : fileRead(sessionId, opts);
}

// Delete all persisted events for a session.
export async function deleteSessionEvents(sessionId: string): Promise<void> {
  if (BACKEND === "d1") await d1Delete(sessionId);
  else await fileDelete(sessionId);
}
