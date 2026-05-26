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

// Cache subdirs not worth persisting — Chrome regenerates them and they're large.
const EXCLUDE_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "Crashpad",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Singleton",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);

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
  const packed = tarPack(dir, {
    ignore: (name) => {
      // `name` is the absolute path. We only care about top-level dir names
      // relative to the profile root, but Chrome can also create caches in
      // nested locations (Default/Cache, Default/Code Cache, ...). Match by basename.
      const base = path.basename(name);
      return EXCLUDE_NAMES.has(base);
    },
  });
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
