// Local-folder backend for profile persistence (no R2).
//
// Layout:  <LOCAL_STORE_DIR>/<profile>/<full userDataDir tree...>
//
// On acquire: copy the baseline into the per-session dir.
// On release: copy the per-session dir back, filtering throwaway cache subdirs
// via shouldExcludeFromPersist. Swap atomically with rm-then-rename so the
// canonical path is never half-written.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { LOCAL_STORE_DIR } from "./config.js";
import { shouldExcludeFromPersist } from "./profile-store.js";
import { log } from "./log.js";

export interface LocalProfileSummary {
  name: string;
  sizeBytes: number | null;
  mtime: Date | null;
}

async function ensureStoreDir(): Promise<void> {
  await fsp.mkdir(LOCAL_STORE_DIR, { recursive: true });
}

function profilePath(profile: string): string {
  return path.join(LOCAL_STORE_DIR, profile);
}

export function profileExists(profile: string): boolean {
  try {
    return fs.statSync(profilePath(profile)).isDirectory();
  } catch {
    return false;
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try {
        total += (await fsp.stat(p)).size;
      } catch { /* removed mid-walk */ }
    }
  }
  return total;
}

export async function listProfiles(): Promise<LocalProfileSummary[]> {
  await ensureStoreDir();
  const entries = await fsp.readdir(LOCAL_STORE_DIR, { withFileTypes: true });
  const out: LocalProfileSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // Skip in-flight swap dirs from a save in progress / interrupted save.
    if (e.name.includes(".next-") || e.name.includes(".old-")) continue;
    const p = path.join(LOCAL_STORE_DIR, e.name);
    let mtime: Date | null = null;
    try {
      mtime = (await fsp.stat(p)).mtime;
    } catch { /* race */ }
    out.push({ name: e.name, sizeBytes: await dirSize(p), mtime });
  }
  return out;
}

// Copy the persistent baseline into `destDir`. Returns true if a baseline
// existed (and was copied), false if this is a first-use empty profile.
export async function loadProfileInto(profile: string, destDir: string): Promise<boolean> {
  if (!profileExists(profile)) return false;
  const src = profilePath(profile);
  // The session dir already exists (caller created it). Copy contents into it.
  // Use cp's filter to skip cache dirs that may have been persisted by an
  // older version of this code. Belt-and-braces — we filter on save too.
  await fsp.cp(src, destDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (s) => !shouldExcludeFromPersist(s),
  });
  log.info("loaded profile from local store", { profile, from: src, to: destDir });
  return true;
}

// Persist `srcDir` as the new baseline for `profile`. Filters out cache subdirs.
// Atomic-ish: writes to a sibling .next-<id> dir, then rm-then-rename swaps it
// onto the canonical path. The brief window where the canonical path is absent
// is acceptable for a single-machine v0 prototype.
export async function saveProfileFrom(profile: string, srcDir: string, sessionId: string): Promise<void> {
  await ensureStoreDir();
  const finalPath = profilePath(profile);
  const stagingPath = path.join(LOCAL_STORE_DIR, `${profile}.next-${sessionId}`);

  // Clean any leftover staging dir from a prior interrupted save.
  await fsp.rm(stagingPath, { recursive: true, force: true });

  await fsp.cp(srcDir, stagingPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (s) => !shouldExcludeFromPersist(s),
  });

  // Swap: drop the old canonical dir then move staging into place.
  await fsp.rm(finalPath, { recursive: true, force: true });
  await fsp.rename(stagingPath, finalPath);

  log.info("saved profile to local store", { profile, dir: finalPath });
}
