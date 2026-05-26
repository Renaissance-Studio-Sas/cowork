// Local profile dir management + tar/untar with cache exclusions.
//
// Per-session dir layout:  <PROFILE_CACHE_DIR>/<profile>-<sessionId>/
// On acquire: download tarball (or seed empty), extract to a fresh dir.
// On release: tar the dir (excluding caches) for R2 upload.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { pack as tarPack, extract as tarExtract } from "tar-fs";
import { PROFILE_CACHE_DIR } from "./config.js";

// Downloadable component caches that Chrome fetches from clients2.google.com
// on first run (~70MB total — `component_crx_cache` alone is ~37M). Contents
// are signed-by-Google CDN payloads, deterministic and identical across users,
// so we share them across all profiles via a single host folder bind-mounted
// at /shared-components in every container. entrypoint.sh symlinks
// /profile/<name> → /shared-components/<name> on container start; this list
// is the single source of truth for which dirs to share.
//
// Safety note: every entry here MUST be user-agnostic. Cookies, Login Data,
// Local Storage, IndexedDB, Preferences, Bookmarks etc. live in `Default/`
// (per-profile) and are NEVER added to this list.
export const SHARED_COMPONENT_DIRS = [
  "component_crx_cache",
  "extensions_crx_cache",
  "WasmTtsEngine",
  "OnDeviceHeadSuggestModel",
  "OptimizationHints",
  "ZxcvbnData",
  "hyphen-data",
  "CertificateRevocation",
  "FirstPartySetsPreloaded",
  "MEIPreload",
  "Subresource Filter",
  "SafetyTips",
  "Crowd Deny",
  "PrivacySandboxAttestationsPreloaded",
  "PKIMetadata",
  "ActorSafetyLists",
  "AmountExtractionHeuristicRegexes",
  "CaptchaProviders",
  "FileTypePolicies",
  "OriginTrials",
  "TrustTokenKeyCommitments",
  "SSLErrorAssistant",
  "WidevineCdm",
] as const;

// Subdirs not worth persisting — Chrome regenerates them and they're large.
// Three groups:
//   - On-disk caches Chrome rebuilds on demand (Cache/, *Cache, Crashpad)
//   - SingletonLock-style files left over from a non-graceful shutdown
//     (the container's entrypoint clears those anyway, but we don't ship them either)
//   - SHARED_COMPONENT_DIRS — the per-profile entry is a symlink to a shared
//     host folder, so excluding it from persistence keeps the saved profile
//     baseline small and lets the bind mount be the source of truth.
export const EXCLUDE_NAMES = new Set<string>([
  // Chrome on-disk caches
  "Cache",
  "Code Cache",
  "GPUCache",
  "GraphiteDawnCache",
  "GrShaderCache",
  "ShaderCache",
  "Crashpad",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  // Singleton lock files (stale after ungraceful shutdown)
  "Singleton",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  // Shared component caches — symlinked into /profile, source of truth lives
  // in SHARED_COMPONENTS_DIR on the host
  ...SHARED_COMPONENT_DIRS,
  // Misc transient
  "Dictionaries",
  "Safe Browsing",
  "BrowserMetrics-spare.pma",
  "BrowserMetrics",
  "first_party_sets.db-journal",
  "segmentation_platform",
]);

// Chrome can stash caches inside nested dirs (Default/Cache, Default/Code Cache, …).
// Matching by basename catches those too.
export function shouldExcludeFromPersist(absPath: string): boolean {
  return EXCLUDE_NAMES.has(path.basename(absPath));
}

export function profileDirFor(profile: string, sessionId: string): string {
  return path.join(PROFILE_CACHE_DIR, `${profile}-${sessionId}`);
}

export function newSessionId(): string {
  return randomUUID().slice(0, 8);
}

export async function ensureCacheDirExists(): Promise<void> {
  await fsp.mkdir(PROFILE_CACHE_DIR, { recursive: true });
}

export async function makeFreshProfileDir(profile: string): Promise<{ dir: string; sessionId: string }> {
  await ensureCacheDirExists();
  const sessionId = newSessionId();
  const dir = profileDirFor(profile, sessionId);
  await fsp.mkdir(dir, { recursive: true });
  return { dir, sessionId };
}

export async function deleteProfileDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

// Stream a gzipped tarball of the profile dir into the writable stream.
// Excludes throwaway cache subdirs and SingletonLock files.
export async function tarProfileDir(dir: string, dest: NodeJS.WritableStream): Promise<void> {
  const packed = tarPack(dir, { ignore: shouldExcludeFromPersist });
  await pipeline(packed, createGzip(), dest);
}

// Extract a gzipped tarball stream into the target dir (creating it first).
export async function untarProfileDir(src: NodeJS.ReadableStream, dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  await pipeline(src, createGunzip(), tarExtract(dir));
}

export function profileDirExists(dir: string): boolean {
  return fs.existsSync(dir);
}
