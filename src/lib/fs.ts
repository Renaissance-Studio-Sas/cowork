import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { relocateSessionsForWorkspace } from "./sessions";
import { CLOUD_PREFIX, sourceOf, type WorkspaceSource } from "./sources";

// Workspace root: the user's own repo / folder that contains `workspaces/`
// plus any shared resources (CLAUDE.md, skills/, scripts/, etc.). Agents get
// read/write access to this whole tree via `additionalDirectories` so they
// can pull in context from anywhere in the repo.
//
// Set WORKSPACE_ROOT in `.env` to point at any directory; defaults to `../..`
// relative to cwd (the legacy layout where this app lived inside a monorepo).
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(process.cwd(), "..", "..");

// Top-level directory containing all workspaces.
//
// Convention (current): <WORKSPACE_ROOT>/workspaces/<workspace>/
//                         workspace.json
//                         <artifact files…>
//                         <child workspace>/workspace.json …
//
// A directory is a workspace iff it contains a `workspace.json` at its root.
// Artifacts live as direct children of the workspace dir (no `files/` wrapper).
// Child workspaces are sibling subfolders that themselves contain a
// workspace.json — they're elided from artifact listings.
export const WORKSPACES_DIR = path.join(WORKSPACE_ROOT, "workspaces");

// Second workspace root: "cloud" workspaces live in a directory *outside*
// WORKSPACE_ROOT. Defaults to ~/Documents/Cowork/Cloud; override with
// COWORK_CLOUD_DIR. Unlike local workspaces (which sit inside the user's repo),
// cloud workspaces form their own self-contained tree with their own optional
// CLAUDE.md — agent sessions started in a cloud workspace run with cwd set to
// this directory (see cwdForWorkspace in src/lib/sessions.ts).
export const CLOUD_WORKSPACES_DIR = process.env.COWORK_CLOUD_DIR
  ? path.resolve(process.env.COWORK_CLOUD_DIR)
  : path.join(process.env.HOME || os.homedir(), "Documents", "Cowork", "Cloud");

// On-disk root directory for each source. A workspace's public slug-chain
// carries the `@cloud` sentinel as its first segment for cloud workspaces (see
// src/lib/sources.ts); `folderPath` stays relative to the source root with no
// sentinel, so the sentinel never appears on disk.
const SOURCE_DIRS: Record<WorkspaceSource, string> = {
  local: WORKSPACES_DIR,
  cloud: CLOUD_WORKSPACES_DIR,
};

// Split a public slug-chain into its source + the inner chain relative to that
// source's root (sentinel stripped). `["@cloud","A","B"]` → cloud / ["A","B"];
// `["A","B"]` → local / ["A","B"]; `["@cloud"]` → cloud / [] (the cloud root).
function splitSource(slugPath: string[]): { source: WorkspaceSource; inner: string[] } {
  const source = sourceOf(slugPath);
  const inner = source === "cloud" ? slugPath.slice(1) : slugPath;
  return { source, inner };
}

// Re-add the source sentinel to an inner chain to form the public slug-chain.
function publicPath(source: WorkspaceSource, inner: string[]): string[] {
  return source === "cloud" ? [CLOUD_PREFIX, ...inner] : inner;
}

// On-disk root directory for a source. Defaults to the local root when the
// source is missing/unknown — workspaces built before the `source` field was
// threaded through (or by callers that don't set it) are local by definition.
function rootDirFor(source: WorkspaceSource | undefined): string {
  return SOURCE_DIRS[source ?? "local"] ?? WORKSPACES_DIR;
}

// Flat directory holding ALL session data — one folder per session id, no
// per-workspace nesting. Each session's meta.json records its own workspace
// path so the directory name doesn't need to encode it.
//
// Defaults to `~/git/cowork-sessions`; override with COWORK_SESSIONS_ROOT.
export const SESSIONS_ROOT = process.env.COWORK_SESSIONS_ROOT
  ? path.resolve(process.env.COWORK_SESSIONS_ROOT)
  : path.join(process.env.HOME || os.homedir(), "git", "cowork-sessions");

// Path to a single session's directory (where meta.json, events.jsonl, and
// input.jsonl live).
export function sessionDir(id: string): string {
  return path.join(SESSIONS_ROOT, id);
}

export type Status = "active" | "archived";

// Suffix that marks a workspace folder as archived. Written with a
// leading space so the bare slug stays readable in `ls` output.
export const ARCHIVED_SUFFIX = " [Archived]";

// Each workspace has a JSON brief at its root with shape
// `{ overview, details, createdAt }`. `overview` is a one-line summary shown
// at the top of the page; `details` is markdown rendered below it. The
// presence of this file is also the marker that the folder *is* a workspace
// (vs. just an artifact subdirectory).
export const WORKSPACE_BRIEF_FILENAME = "workspace.json";

export interface Brief {
  overview: string;
  details: string;     // markdown
  createdAt: string;   // ISO timestamp
}

// A unit of work — what used to be a `Project` or a `Task`, unified.
// Workspaces are nestable: every workspace can hold child workspaces in turn.
// The on-disk layout mirrors the tree: `workspaces/A/B/C/` is a workspace
// `C` whose ancestor chain is `["A", "B"]`. The repo's old 2-level
// convention (projects → tasks) becomes one of many possible depths.
export interface Workspace {
  // Which root this workspace lives in. Derivable from `path[0]` but stored
  // explicitly so callers (and the DTO) don't have to re-parse the sentinel.
  source: WorkspaceSource;
  slug: string;            // bare slug, without any archived suffix
  folderName: string;      // basename on disk (may carry ARCHIVED_SUFFIX)
  // Full slug-chain from the top-level workspace down to and including this
  // one. `["HR", "pay-contractors"]` identifies the workspace previously
  // known as task `pay-contractors` of project `HR`. Used as the workspace
  // identifier in session metas, URLs, and APIs.
  path: string[];
  // Filesystem ancestor folder names, one per segment of `path`. Carries the
  // ` [Archived]` suffix per-segment so a parent's archived state is
  // distinguishable. `workspaceDir(ws)` reconstructs the on-disk path from
  // this.
  folderPath: string[];
  status: Status;
  overview: string;
  details: string;
  createdAt: string;
  children: Workspace[];
}

// Resolved on-disk directory for a workspace. `folderPath` is relative to the
// workspace's own source root (no sentinel), so resolution is just root + path.
export function workspaceDir(ws: Workspace): string {
  return path.join(rootDirFor(ws.source), ...ws.folderPath);
}

// Legacy prefix pattern. Folders created before the switch to the
// archived-suffix scheme still use `wip-<slug>` (active) and
// `done-<slug>` (archived). We parse them so an unmigrated workspace
// keeps working; a one-shot rename brings them into the new scheme.
const LEGACY_PREFIX_RE = /^(wip|done)-(.+)$/;

// Parse a folder name into { status, slug }. Returns null for entries
// that aren't workspace folders (dotfiles, the bootstrap `files/` dir, etc.).
// Skipping is the caller's responsibility.
function parseFolderName(folderName: string): { status: Status; slug: string } {
  if (folderName.endsWith(ARCHIVED_SUFFIX)) {
    return { status: "archived", slug: folderName.slice(0, -ARCHIVED_SUFFIX.length) };
  }
  const legacy = folderName.match(LEGACY_PREFIX_RE);
  if (legacy) {
    return { status: legacy[1] === "done" ? "archived" : "active", slug: legacy[2] };
  }
  return { status: "active", slug: folderName };
}

// Build a folder name from a slug + status.
function folderNameFor(slug: string, status: Status): string {
  return status === "archived" ? `${slug}${ARCHIVED_SUFFIX}` : slug;
}

// Two folders can collapse to the same slug — e.g. a migrated `X` folder next
// to a leftover legacy `wip-X`, or a stray git worktree whose container dir
// happens to start with `wip-`/`done-`. Emitting both crashes the sidebar with
// React duplicate-key warnings and makes /workspace/<slug> routing ambiguous.
// Keep the most "real" one: a folder with an actual brief beats an empty one,
// a canonical (un-prefixed, un-suffixed) name beats a legacy/archived variant,
// and active beats archived. Deterministic, so the UI is stable across reloads.
type Slugged = Pick<Workspace, "slug" | "folderName" | "status" | "overview" | "details" | "createdAt">;

function realnessScore(x: Slugged): number {
  let score = 0;
  if (x.createdAt || x.overview || x.details) score += 4; // has a brief
  if (x.folderName === x.slug) score += 2;                // canonical folder name
  if (x.status === "active") score += 1;
  return score;
}

function dedupeBySlug<T extends Slugged>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const x of items) {
    const cur = best.get(x.slug);
    if (!cur || realnessScore(x) > realnessScore(cur)) best.set(x.slug, x);
  }
  return [...best.values()];
}

// The folder name *is* the display name. Sanitize only what the filesystem
// genuinely can't handle (path separators + a few illegal chars) and what
// would clash with our naming scheme. Preserve case, spaces, and most
// punctuation so renames keep the user's intent intact.
function sanitizeName(s: string): string {
  let out = s.normalize("NFC").trim();
  out = out.replace(/[/\\:*?"<>|]+/g, "-");
  out = out.replace(/\s+/g, " ");
  out = out.replace(/^[.-]+|[.-]+$/g, "");
  // Reject the legacy wip-/done- prefixes — they would round-trip into the
  // wrong slug after migration. Reject a trailing archived suffix too, so
  // archive state is only ever set via setWorkspaceStatus.
  out = out.replace(/^(wip|done)-+/i, "");
  while (out.toLowerCase().endsWith(ARCHIVED_SUFFIX.toLowerCase())) {
    out = out.slice(0, -ARCHIVED_SUFFIX.length).trimEnd();
  }
  // Reserve the `@cloud` source sentinel — a real workspace can't be named it,
  // or it would shadow the cloud root in slug-chain resolution.
  if (out.toLowerCase() === CLOUD_PREFIX.toLowerCase()) out = "";
  return out.slice(0, 80);
}

// Cheap name-based filter for entries that could *possibly* be workspaces.
// The authoritative check is `dirIsWorkspace` (presence of workspace.json),
// applied by `listChildrenAt` after this filter — but eliminating dotfiles
// and legacy reserved names here avoids the per-folder fs.access I/O for
// them.
const RESERVED_FOLDER_NAMES = new Set(["sessions"]);

function isWorkspaceFolder(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (RESERVED_FOLDER_NAMES.has(name)) return false;
  return true;
}

// A directory IS a workspace iff it contains a `workspace.json` at its root
// — that's the design's authoritative definition (see CLAUDE.md). Used to
// distinguish a child workspace from an artifact folder in mixed layouts.
async function dirIsWorkspace(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, WORKSPACE_BRIEF_FILENAME));
    return true;
  } catch {
    return false;
  }
}

// Read a brief JSON file. Missing/unparseable files return an empty brief
// so callers don't have to handle the absence case — a workspace with
// no brief yet just renders blank fields in the UI.
async function readBrief(filePath: string): Promise<Brief> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<Brief>;
    return {
      overview: typeof parsed.overview === "string" ? parsed.overview : "",
      details: typeof parsed.details === "string" ? parsed.details : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return { overview: "", details: "", createdAt: "" };
  }
}

async function writeBrief(filePath: string, brief: Brief): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(brief, null, 2) + "\n", "utf8");
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureWorkspace(): Promise<void> {
  // Make sure both source roots exist so each section is browsable. The cloud
  // root may be a brand-new directory the user just pointed us at.
  await Promise.all([
    fs.mkdir(WORKSPACES_DIR, { recursive: true }),
    fs.mkdir(CLOUD_WORKSPACES_DIR, { recursive: true }),
  ]);
  // Bootstrap a default `Inbox/` catch-all ONLY when the LOCAL root has no
  // workspaces at all (fresh install). Once the user has any workspace, we
  // never auto-create — they're free to rename, delete, or replace the
  // catch-all. The cloud root is left empty (the user maps it to their own
  // directory) and just shows "No cloud workspaces yet." when empty.
  let hasAny = false;
  try {
    const entries = await fs.readdir(WORKSPACES_DIR, { withFileTypes: true });
    hasAny = entries.some((e) => e.isDirectory() && isWorkspaceFolder(e.name));
  } catch { /* empty or missing — treat as none */ }
  if (hasAny) return;

  const inboxPath = path.join(WORKSPACES_DIR, "Inbox");
  await fs.mkdir(inboxPath, { recursive: true });
  await writeBrief(path.join(inboxPath, WORKSPACE_BRIEF_FILENAME), {
    overview: "Default workspace. Anything you don't want to file elsewhere goes here.",
    details: "",
    createdAt: nowIso(),
  });
}

// Recursively list workspaces under a parent folder on disk. `rootDir` is the
// source root the listing is anchored to; `parentFolderPath` is the list of
// ancestor folder names (root-relative, with archived suffix preserved) and
// `parentSlugPath` is the matching PUBLIC slug-chain (carrying the `@cloud`
// sentinel for the cloud source) — both empty/`[CLOUD_PREFIX]` at the top.
async function listChildrenAt(
  rootDir: string,
  parentFolderPath: string[],
  parentSlugPath: string[],
): Promise<Workspace[]> {
  const dir = path.join(rootDir, ...parentFolderPath);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Workspace[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!isWorkspaceFolder(e.name)) continue;
    const parsed = parseFolderName(e.name);
    const folderPath = [...parentFolderPath, e.name];
    const slugPath = [...parentSlugPath, parsed.slug];
    const wsDir = path.join(rootDir, ...folderPath);
    // Authoritative workspace check: presence of workspace.json. Without it
    // a subfolder is an artifact directory (e.g. a `files/` legacy dir, an
    // exported assets bundle, etc.) and must not appear in the workspace tree.
    if (!(await dirIsWorkspace(wsDir))) continue;
    const brief = await readBrief(path.join(wsDir, WORKSPACE_BRIEF_FILENAME));
    const children = await listChildrenAt(rootDir, folderPath, slugPath);
    out.push({
      source: sourceOf(slugPath),
      slug: parsed.slug,
      folderName: e.name,
      path: slugPath,
      folderPath,
      status: parsed.status,
      overview: brief.overview,
      details: brief.details,
      createdAt: brief.createdAt,
      children,
    });
  }
  const deduped = dedupeBySlug(out);
  deduped.sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
  return deduped;
}

// Top-level workspaces (with child trees) for a single source.
async function listSource(source: WorkspaceSource): Promise<Workspace[]> {
  return listChildrenAt(rootDirFor(source), [], publicPath(source, []));
}

// All top-level workspaces from BOTH sources, with their child trees
// materialized. Local first, then cloud — the sidebar splits them back out by
// `source` into its "Local workspaces" / "Cloud workspaces" sections.
export async function listWorkspaces(): Promise<Workspace[]> {
  await ensureWorkspace();
  const [local, cloud] = await Promise.all([listSource("local"), listSource("cloud")]);
  return [...local, ...cloud];
}

// Walk a workspace tree looking for the workspace at `slugPath`. Slug
// segments are matched exactly. Returns null if any segment is missing.
function findInTree(tree: Workspace[], slugPath: string[]): Workspace | null {
  if (slugPath.length === 0) return null;
  let level = tree;
  let current: Workspace | null = null;
  for (const segment of slugPath) {
    const next = level.find((w) => w.slug === segment);
    if (!next) return null;
    current = next;
    level = next.children;
  }
  return current;
}

// Resolve a workspace by its slug-chain — e.g. `["HR", "pay-contractors"]`
// returns what used to be task `pay-contractors` of project `HR`, and
// `["@cloud","Inbox"]` the cloud workspace "Inbox". We resolve only the
// relevant source's tree and match against the inner (sentinel-stripped) chain,
// since the tree nodes carry bare slugs. An empty inner chain (`["@cloud"]`
// alone, or `[]`) has no workspace to return.
export async function getWorkspace(slugPath: string[]): Promise<Workspace | null> {
  const { source, inner } = splitSource(slugPath);
  if (inner.length === 0) return null;
  const tree = await listSource(source);
  return findInTree(tree, inner);
}

// Create a workspace at `parentPath` (empty for a top-level workspace) with
// the given slug.
export async function createWorkspace(
  parentPath: string[],
  slug: string,
  brief: Partial<Brief> = {},
): Promise<Workspace> {
  const clean = sanitizeName(slug);
  if (!clean) throw new Error("invalid name");

  // `parentPath` is a PUBLIC chain. Split off the source: an empty inner chain
  // (`[]` → local root, or `["@cloud"]` → cloud root) creates a top-level
  // workspace in that source; otherwise it's a child of the named parent.
  const { source, inner } = splitSource(parentPath);
  let parentDir = rootDirFor(source);
  if (inner.length > 0) {
    const parent = await getWorkspace(parentPath);
    if (!parent) throw new Error(`unknown parent workspace ${parentPath.join("/")}`);
    parentDir = workspaceDir(parent);
  }

  const folder = folderNameFor(clean, "active");
  const dir = path.join(parentDir, folder);
  await fs.mkdir(dir, { recursive: true });
  await writeBrief(path.join(dir, WORKSPACE_BRIEF_FILENAME), {
    overview: brief.overview ?? "",
    details: brief.details ?? "",
    createdAt: brief.createdAt ?? nowIso(),
  });
  const created = await getWorkspace(publicPath(source, [...inner, clean]));
  if (!created) throw new Error("created workspace not found");
  return created;
}

// Overwrite a workspace's brief (overview + details), preserving createdAt.
// Used by the New-Workspace planning flow when the user accepts the plan:
// the workspace was created as a stub, and accepting fills in the real brief.
export async function setWorkspaceBrief(
  slugPath: string[],
  patch: { overview?: string; details?: string },
): Promise<void> {
  const ws = await getWorkspace(slugPath);
  if (!ws) throw new Error(`unknown workspace ${slugPath.join("/")}`);
  const briefPath = path.join(workspaceDir(ws), WORKSPACE_BRIEF_FILENAME);
  const current = await readBrief(briefPath);
  await writeBrief(briefPath, {
    overview: patch.overview ?? current.overview,
    details: patch.details ?? current.details,
    createdAt: current.createdAt || nowIso(),
  });
}

export async function setWorkspaceStatus(slugPath: string[], status: Status): Promise<void> {
  const ws = await getWorkspace(slugPath);
  if (!ws) throw new Error(`unknown workspace ${slugPath.join("/")}`);
  if (ws.status === status) return;
  const parentDir = path.dirname(workspaceDir(ws));
  const newFolder = folderNameFor(ws.slug, status);
  await fs.rename(workspaceDir(ws), path.join(parentDir, newFolder));
}

export async function renameWorkspace(slugPath: string[], newSlug: string): Promise<void> {
  const ws = await getWorkspace(slugPath);
  if (!ws) throw new Error(`unknown workspace ${slugPath.join("/")}`);
  const clean = sanitizeName(newSlug);
  if (!clean) throw new Error("invalid name");
  if (clean === ws.slug) return;
  const parentSlugPath = slugPath.slice(0, -1);
  const parentDir = path.dirname(workspaceDir(ws));
  const collision = await getWorkspace([...parentSlugPath, clean]);
  if (collision) throw new Error(`workspace "${clean}" already exists at this level`);

  const newFolder = folderNameFor(clean, ws.status);
  await fs.rename(workspaceDir(ws), path.join(parentDir, newFolder));
  // Note: no SDK-transcript rename needed. Sessions run with cwd=WORKSPACE_ROOT,
  // so all transcripts live in a single workspace-keyed directory regardless of
  // which workspace owns the session — renaming a workspace doesn't change
  // that path.
  await relocateSessionsForWorkspace(slugPath, [...parentSlugPath, clean]);
}

export async function deleteWorkspace(slugPath: string[]): Promise<void> {
  const ws = await getWorkspace(slugPath);
  if (!ws) throw new Error(`unknown workspace ${slugPath.join("/")}`);
  await fs.rm(workspaceDir(ws), { recursive: true, force: true });
}

// Move a workspace to a new parent (or to the top level if `toParentPath` is
// empty). The slug is preserved unless it would collide at the destination,
// in which case `-2`, `-3`, … is appended. Returns the new slug-chain.
export async function moveWorkspace(
  slugPath: string[],
  toParentPath: string[],
): Promise<string[]> {
  const ws = await getWorkspace(slugPath);
  if (!ws) throw new Error(`unknown workspace ${slugPath.join("/")}`);

  // No-op if already at this parent.
  const currentParent = slugPath.slice(0, -1);
  const sameParent =
    currentParent.length === toParentPath.length
    && currentParent.every((s, i) => s === toParentPath[i]);
  if (sameParent) return slugPath;

  // Prevent moving a workspace under itself or its own descendant.
  if (toParentPath.length >= slugPath.length
      && slugPath.every((s, i) => toParentPath[i] === s)) {
    throw new Error("cannot move a workspace under itself");
  }

  // Local and cloud roots are different (possibly cross-device) filesystems —
  // fs.rename across them fails (EXDEV), and the slug-chain identity would
  // change source mid-move. Disallow it; the user can recreate instead.
  if (sourceOf(slugPath) !== sourceOf(toParentPath)) {
    throw new Error("cannot move between local and cloud workspaces");
  }

  // Destination directory: the source root when targeting a top-level slot
  // (`[]` local or `["@cloud"]` cloud), else the named parent's folder.
  const { source: destSource, inner: destInner } = splitSource(toParentPath);
  let destDir = rootDirFor(destSource);
  if (destInner.length > 0) {
    const dest = await getWorkspace(toParentPath);
    if (!dest) throw new Error(`unknown destination ${toParentPath.join("/")}`);
    destDir = workspaceDir(dest);
  }

  // Slug collision resolution — sibling workspaces (any status) at the
  // destination define the namespace.
  let finalSlug = ws.slug;
  const siblings = destInner.length === 0
    ? await listSource(destSource)
    : (await getWorkspace(toParentPath))!.children;
  if (siblings.find((s) => s.slug === finalSlug)) {
    let i = 2;
    while (siblings.find((s) => s.slug === `${ws.slug}-${i}`)) i++;
    finalSlug = `${ws.slug}-${i}`;
  }

  const newFolder = folderNameFor(finalSlug, ws.status);
  await fs.rename(workspaceDir(ws), path.join(destDir, newFolder));
  const newPath = [...toParentPath, finalSlug];
  await relocateSessionsForWorkspace(slugPath, newPath);
  return newPath;
}

// ---------------------------------------------------------------------------
// Files inside a workspace's `files/` folder (artifacts).
// ---------------------------------------------------------------------------

function ensureSafePath(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new Error("path escapes workspace directory");
  }
  return target;
}

// Files to hide from artifact listings (macOS metadata, etc.)
const HIDDEN_FILES = new Set([".DS_Store"]);

// Artifacts live directly in the workspace directory, alongside the
// workspace.json brief and any child workspace folders. Walking artifact
// listings therefore has to skip:
//   - the brief itself (workspace.json at the root)
//   - any subdirectory that is itself a workspace (has its own
//     workspace.json) — those are nested workspaces, not artifact folders
//   - dotfiles and macOS metadata
//
// Subdirectories that *aren't* workspaces are normal artifact folders and
// get walked recursively so e.g. `docs/foo.md` shows up in the artifact list.
async function walkArtifacts(base: string, dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (HIDDEN_FILES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      // Hide the workspace brief at every level — including any nested
      // workspaces' briefs we won't recurse into (defensive).
      if (e.name === WORKSPACE_BRIEF_FILENAME) continue;
      out.push(path.relative(base, full));
    } else if (e.isDirectory()) {
      // Recurse only into pure artifact folders; child workspaces own
      // their own files and surface them through their own listing.
      if (await dirIsWorkspace(full)) continue;
      await walkArtifacts(base, full, out);
    }
  }
}

async function listFilesIn(base: string): Promise<string[]> {
  const out: string[] = [];
  await walkArtifacts(base, base, out);
  return out;
}

export interface FileMeta {
  path: string;
  /** Modification time in epoch milliseconds. */
  mtime: number;
}

// Same listing as listFilesIn but carries each file's mtime so callers can
// sort artifacts by recency.
async function listFilesMetaIn(base: string): Promise<FileMeta[]> {
  const paths = await listFilesIn(base);
  return Promise.all(
    paths.map(async (rel) => {
      const full = path.join(base, rel);
      let mtime = 0;
      try { mtime = (await fs.stat(full)).mtimeMs; } catch { /* ignore */ }
      return { path: rel, mtime };
    }),
  );
}

// Artifacts and the brief share the workspace directory in the current
// layout — there's no `files/` wrapper. We keep this indirection so the
// route layer doesn't depend on that detail.
async function workspaceFilesDir(slugPath: string[]): Promise<string | null> {
  const ws = await getWorkspace(slugPath);
  if (!ws) return null;
  return workspaceDir(ws);
}

export async function listFiles(slugPath: string[]): Promise<string[]> {
  const base = await workspaceFilesDir(slugPath);
  if (!base) return [];
  return listFilesIn(base);
}

export async function listFilesMeta(slugPath: string[]): Promise<FileMeta[]> {
  const base = await workspaceFilesDir(slugPath);
  if (!base) return [];
  return listFilesMetaIn(base);
}

export async function readFileText(slugPath: string[], rel: string): Promise<string> {
  const base = await workspaceFilesDir(slugPath);
  if (!base) throw new Error("not found");
  const full = ensureSafePath(base, rel);
  return fs.readFile(full, "utf8");
}

export async function writeFileText(slugPath: string[], rel: string, content: string): Promise<void> {
  const base = await workspaceFilesDir(slugPath);
  if (!base) throw new Error("not found");
  const full = ensureSafePath(base, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

export async function readFileBytes(slugPath: string[], rel: string): Promise<Uint8Array> {
  const base = await workspaceFilesDir(slugPath);
  if (!base) throw new Error("not found");
  const full = ensureSafePath(base, rel);
  const buf = await fs.readFile(full);
  return new Uint8Array(buf);
}

export async function workspaceFileExists(slugPath: string[], rel: string): Promise<boolean> {
  try {
    await readFileText(slugPath, rel);
    return true;
  } catch { return false; }
}

export async function workspaceDirFor(slugPath: string[]): Promise<string> {
  const ws = await getWorkspace(slugPath);
  if (!ws) throw new Error("not found");
  return workspaceDir(ws);
}

export async function renameFile(slugPath: string[], from: string, to: string): Promise<void> {
  const base = await workspaceFilesDir(slugPath);
  if (!base) throw new Error("not found");
  if (from === WORKSPACE_BRIEF_FILENAME) throw new Error(`${WORKSPACE_BRIEF_FILENAME} cannot be renamed`);
  if (!to.trim()) throw new Error("destination required");
  const src = ensureSafePath(base, from);
  const dst = ensureSafePath(base, to);
  // Don't allow overwriting existing files.
  try { await fs.access(dst); throw new Error(`${to} already exists`); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      if ((err as Error).message?.includes("already exists")) throw err;
    }
  }
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.rename(src, dst);
}

export async function deleteFile(slugPath: string[], rel: string): Promise<void> {
  const base = await workspaceFilesDir(slugPath);
  if (!base) throw new Error("not found");
  if (rel === WORKSPACE_BRIEF_FILENAME) throw new Error(`${WORKSPACE_BRIEF_FILENAME} cannot be deleted`);
  const full = ensureSafePath(base, rel);
  await fs.rm(full, { recursive: true, force: true });
}

// Walk every session folder under SESSIONS_ROOT and fix any meta.json whose
// `cwd` drifted from the current WORKSPACE_ROOT (e.g. the user pointed cowork
// at a different workspace path between runs). Without this, resume({ cwd })
// would look in the wrong `~/.claude/projects/<encoded-cwd>/` and miss the
// SDK transcript.
//
// With flat session storage the directory no longer encodes the workspace
// path, so no workspace drift is possible: meta.json IS the source of truth
// for which workspace a session belongs to. Only meta.cwd can drift from
// configuration.
//
// Called once on module load with a globalThis guard for HMR. Best effort —
// failures are logged but never throw.
export async function reconcileSessionsOnDisk(): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(SESSIONS_ROOT, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // First boot before any sessions exist — fine. Anything else, log.
    if (e.code !== "ENOENT") {
      console.warn(`[reconcile] could not read ${SESSIONS_ROOT}:`, e.message);
    }
    return;
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const metaPath = path.join(SESSIONS_ROOT, String(d.name), "meta.json");
    let meta: { workspace?: string[]; cwd?: string; sdkSessionId?: string; [k: string]: unknown };
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch { continue; }
    if (meta.cwd === WORKSPACE_ROOT) continue;

    const oldCwd = typeof meta.cwd === "string" ? meta.cwd : null;
    const sdkSessionId = typeof meta.sdkSessionId === "string" ? meta.sdkSessionId : null;
    console.log(
      `[reconcile] session ${String(d.name)}: cwd ${meta.cwd ?? "?"} → ${WORKSPACE_ROOT}`,
    );
    meta.cwd = WORKSPACE_ROOT;
    try {
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch (err) {
      const e = err as Error;
      console.warn(`[reconcile] could not rewrite ${metaPath}:`, e.message);
      continue;
    }

    // Move the SDK transcript jsonl from the old cwd's encoded directory to
    // the new one so `resume({ cwd })` finds it. We intentionally do NOT
    // rename the encoded directory itself — see git history for the
    // concatenated-path corruption that approach produced.
    if (oldCwd && sdkSessionId) {
      await moveSdkTranscriptFile(sdkSessionId, oldCwd, WORKSPACE_ROOT);
    }
  }
}

// Move a single SDK transcript jsonl from one cwd's encoded directory to
// another's. No-op if the source is missing.
async function moveSdkTranscriptFile(
  sdkSessionId: string,
  oldCwd: string,
  newCwd: string,
): Promise<void> {
  const encode = (p: string) => p.replaceAll("/", "-");
  const base = path.join(os.homedir(), ".claude", "projects");
  const src = path.join(base, encode(oldCwd), `${sdkSessionId}.jsonl`);
  const dst = path.join(base, encode(newCwd), `${sdkSessionId}.jsonl`);
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      console.warn(`[reconcile] could not move SDK transcript ${src} → ${dst}:`, e.message);
    }
  }
}

