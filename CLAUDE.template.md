# <Your repo / project name>

This directory is a [cowork](https://github.com/Renaissance-Studio-Sas/cowork) workspace. Cowork lets you and Claude agents pick up work in parallel, each with its own folder of artifacts and conversation history.

## Folder structure

Cowork's data model is recursive: every unit of work is a **workspace**, and any workspace can have child workspaces. Workspaces live under a `workspaces/` directory at the repo root. A directory is a workspace *iff* it contains a `workspace.json` at its root. Subfolders without one are plain artifact folders.

```
<repo-root>/                     # WORKSPACE_ROOT in cowork's .env
├── CLAUDE.md                    # This file — high-level repo context, conventions, links
├── workspaces/                  # The workspace tree lives here
│   ├── Inbox/                   # Default catch-all (auto-created on a fresh tree)
│   │   └── workspace.json
│   └── <Workspace>/             # Folder name == display name == slug
│       ├── workspace.json       # Brief — { overview, details, createdAt, status }
│       ├── <artifact files…>    # Artifacts (PDFs, HTML, data, scripts) live here directly
│       └── <Child Workspace>/   # Any subfolder that itself contains a workspace.json
│           ├── workspace.json
│           └── <artifact files…>
└── <anything else>              # skills/, scripts/, src/, etc. — agents can read these too
```

**Key conventions:**

- **Archived state lives in the brief.** `workspace.json`'s `status` field is `"active"` or `"archived"`; Archive/Restore in the UI just flips it. (No folder-name suffix.)
- **Folder name = display name.** Cowork preserves case, spaces, and most punctuation. Use "House Sale" not "house-sale".
- **`workspace.json` is the brief.** Lives at the workspace root, *not* in a `files/` subfolder. Shape: `{ "overview": "one-line summary", "details": "markdown body", "createdAt": "ISO timestamp", "status": "active" }`. The UI renders `overview` at the top and `details` (markdown) below it; the JSON itself is hidden from the artifact list.
- **Artifacts sit directly in the workspace folder**, alongside `workspace.json` — there is no `files/` wrapper. Child workspaces (subfolders with their own `workspace.json`) are surfaced as nested workspaces, not artifacts.
- **Conversation history is auto-managed** in a separate sessions store. Safe to ignore unless reviewing history.

## How agents see your workspace

When you start an agent, its `cwd` is the **workspace root** so `CLAUDE.md` / `GEMINI.md` are picked up and the whole tree is reachable. The agent is told its specific workspace folder (the path to write artifacts into) and brief via the system prompt. Shared context like `CLAUDE.md`, `skills/`, or `scripts/` at the top level is therefore available to every agent on every workspace.

This means: anything you document in this file (or any shared folder) is automatically available to every agent on every task. Use it to record conventions, glossaries, people, services, gotchas — anything an agent would want to know.

## Suggested top-level sections

Customize this template with whatever's load-bearing for your work. Common sections:

- **People** — names, emails, roles for anyone agents might draft messages for.
- **Services / APIs** — what's running where, how to authenticate.
- **Conventions** — how you name things, where files belong, what "done" means.
- **Skills** — operational know-how organized by area (see [`skills/`](skills/) pattern).
- **Glossary** — terms and acronyms that only make sense inside this org.

## Getting started

```bash
# 1. Clone cowork and configure it to point at this workspace
git clone https://github.com/Renaissance-Studio-Sas/cowork.git
cd cowork
echo "WORKSPACE_ROOT=$(realpath ../<this-folder>)" > .env

# 2. Install and run
npm install
npm run dev

# 3. Open http://localhost:3100 — cowork will bootstrap a default `Inbox/`
#    workspace here if the root is empty.
```

Rename `Inbox/` to whatever fits your work, then create workspaces via the UI or by adding folders (each with a `workspace.json`) anywhere in the tree.
