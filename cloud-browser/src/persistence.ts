// Unified profile-persistence backend. Dispatches to either R2 (cloud) or
// the local-folder store based on PERSISTENCE_BACKEND.
//
//   listProfiles()      — enumerate persisted profiles + their size/mtime
//   loadProfileInto()   — populate a fresh per-session userDataDir from the baseline
//   saveProfileFrom()   — write the per-session userDataDir back as the new baseline
//
// Both backends apply the same cache-exclusion list (EXCLUDE_NAMES) so only
// real login state — cookies, Local Storage, IndexedDB, Login Data, Preferences,
// etc. — is persisted.

import { createWriteStream, promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { LOCAL_STORE_DIR, PERSISTENCE_BACKEND, R2 } from "./config.js";
import * as r2 from "./r2-client.js";
import * as local from "./local-store.js";
import * as store from "./profile-store.js";
import { log } from "./log.js";

export const backend = PERSISTENCE_BACKEND;

// One-line human-readable description of where profiles get saved. Used in
// tool output so the agent (and user) can see at a glance which backend is
// active without having to inspect env vars.
export function describeBackend(): string {
  return PERSISTENCE_BACKEND === "r2"
    ? `R2 bucket "${R2!.bucket}"`
    : `local folder "${LOCAL_STORE_DIR}"`;
}

export interface ProfileSummary {
  name: string;
  sizeBytes: number | null;
  mtime: Date | null;
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  if (PERSISTENCE_BACKEND === "r2") {
    return (await r2.listProfiles()).map((p) => ({
      name: p.name,
      sizeBytes: p.size,
      mtime: p.lastModified,
    }));
  }
  return (await local.listProfiles()).map((p) => ({
    name: p.name,
    sizeBytes: p.sizeBytes,
    mtime: p.mtime,
  }));
}

// Populate `destDir` (the per-session userDataDir) with this profile's baseline.
// Returns true if a baseline existed, false if this is a first-use empty profile.
export async function loadProfileInto(profile: string, destDir: string): Promise<boolean> {
  if (PERSISTENCE_BACKEND === "r2") {
    const tarball = await r2.downloadProfileTarball(profile);
    if (!tarball) return false;
    await store.untarProfileDir(tarball, destDir);
    log.info("seeded profile from R2", { profile, dir: destDir });
    return true;
  }
  return local.loadProfileInto(profile, destDir);
}

// Persist `srcDir` (the per-session userDataDir, post-release) as the new
// baseline for `profile`. Returns true on success.
export async function saveProfileFrom(
  profile: string,
  srcDir: string,
  sessionId: string,
): Promise<boolean> {
  if (PERSISTENCE_BACKEND === "r2") {
    const tmp = path.join(os.tmpdir(), `cbmcp-${profile}-${sessionId}.tar.gz`);
    const dest = createWriteStream(tmp);
    await store.tarProfileDir(srcDir, dest);
    const buf = await fsp.readFile(tmp);
    const uploaded = await r2.uploadProfileTarball(profile, buf);
    await fsp.unlink(tmp).catch(() => undefined);
    if (uploaded) log.info("profile uploaded to R2", { profile, bytes: buf.length });
    return uploaded;
  }
  await local.saveProfileFrom(profile, srcDir, sessionId);
  return true;
}
