# <Your repo / project name>

This directory is a [cowork](https://github.com/Renaissance-Studio-Sas/cowork) workspace. Cowork lets you and Claude agents pick up tasks in parallel, each with its own folder of artifacts and conversation history.

## Folder structure

```
<workspace-root>/                # WORKSPACE_ROOT in cowork's .env
├── CLAUDE.md                    # This file — high-level repo context, conventions, links
├── projects/                    # All cowork projects live here
│   ├── wip-<project>/           # Active project (folder prefix encodes status)
│   │   ├── files/
│   │   │   └── project.md       # Project description + labels
│   │   ├── wip-<task>/          # Active task within the project
│   │   │   ├── files/
│   │   │   │   ├── task.md      # Task description + status
│   │   │   │   └── ...          # Artifacts (PDFs, HTML, data, scripts)
│   │   │   └── sessions/        # Agent conversation history (auto-created)
│   │   └── done-<task>/         # Completed task
│   └── done-<project>/          # Archived project
└── <anything else>              # skills/, scripts/, src/, etc. — agents can read these too
```

**Key conventions:**

- **Status by folder prefix.** `wip-` for in-progress, `done-` for completed. Cowork's UI flips this by renaming the folder.
- **Folder name = display name.** Cowork preserves case, spaces, and most punctuation. Use "House Sale" not "house-sale".
- **`task.md` lives inside `files/`** alongside other artifacts — it's just another file the agent reads and writes.
- **`sessions/` is auto-managed.** Each entry is one agent conversation: `meta.json`, `events.jsonl`, `input.jsonl`. Safe to ignore unless reviewing history.

## How agents see your workspace

When you start an agent on a task, its `cwd` is the task folder (e.g. `projects/wip-Todos/wip-foo/`). Agents are also granted read/write access to the whole **workspace root** via `additionalDirectories`, so they can pull in shared context like `CLAUDE.md`, `skills/`, `scripts/`, or any other file you keep at the top level.

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

# 3. Open http://localhost:3100 — cowork will bootstrap an empty `projects/`
#    folder here if one doesn't exist, with a default `wip-todo/` project.
```

Rename `wip-todo/` to whatever fits your work, then create tasks via the UI or by adding folders directly under `projects/`.
