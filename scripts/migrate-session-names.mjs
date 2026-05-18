#!/usr/bin/env node
/**
 * Migration script to generate content-based labels for existing sessions.
 * Reads the first message from input.jsonl and creates a short descriptive label.
 * Also calls the rename API to update live sessions.
 *
 * Run from the agent-workbench directory: node scripts/migrate-session-names.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";

const API_BASE = "http://localhost:3000";

// Generate a short label from the first message (same logic as sessions.ts)
function generateSessionLabel(firstMessage) {
  // Clean up the message
  let text = firstMessage
    .trim()
    .replace(/^(can you|could you|please|hey|hi|hello|I want to|I need to|I'd like to|let's|we should)\s*/gi, "")
    .replace(/[?!.]+$/, "")
    .trim();

  // If it starts with a verb, capitalize it; otherwise add context
  const words = text.split(/\s+/);
  if (words.length === 0) return "New session";

  // Capitalize first letter
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);

  // Take first ~5 words or ~40 chars, whichever is shorter
  let label = "";
  for (const word of words) {
    if (label.length + word.length > 40) break;
    label += (label ? " " : "") + word;
  }

  return label || "New session";
}

const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../../../tasks");

async function findSessionDirs(dir) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Check if this is a session directory (has meta.json)
        const metaPath = path.join(fullPath, "meta.json");
        try {
          await fs.access(metaPath);
          if (dir.includes("/sessions")) {
            results.push(fullPath);
          }
        } catch {
          // Not a session dir, recurse
          results.push(...await findSessionDirs(fullPath));
        }
      }
    }
  } catch {
    // Ignore permission errors, etc.
  }
  return results;
}

async function migrate() {
  console.log("Scanning workspace:", WORKSPACE_ROOT);

  const sessionDirs = await findSessionDirs(WORKSPACE_ROOT);
  console.log(`Found ${sessionDirs.length} session(s) to migrate\n`);

  let migrated = 0;
  let errors = 0;

  for (const sessionDir of sessionDirs) {
    const metaPath = path.join(sessionDir, "meta.json");
    const inputPath = path.join(sessionDir, "input.jsonl");
    const sessionId = path.basename(sessionDir);

    try {
      const raw = await fs.readFile(metaPath, "utf8");
      const meta = JSON.parse(raw);

      // Read first message from input.jsonl
      let firstMessage = "";
      try {
        const inputRaw = await fs.readFile(inputPath, "utf8");
        const firstLine = inputRaw.split("\n").find(Boolean);
        if (firstLine) {
          firstMessage = JSON.parse(firstLine).text || "";
        }
      } catch {
        // No input.jsonl, use fallback
      }

      const newName = firstMessage ? generateSessionLabel(firstMessage) : "New session";

      // Update meta.json on disk
      meta.name = newName;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

      // Also call the rename API to update live sessions
      const projectSlug = meta.project || "";
      const taskSlug = meta.task || "";

      try {
        const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectSlug, taskSlug, name: newName }),
        });
        if (res.ok) {
          console.log(`  MIGRATED (live): ${sessionId} → "${newName}"`);
        } else {
          console.log(`  MIGRATED (disk): ${sessionId} → "${newName}"`);
        }
      } catch {
        // API not available, just update disk
        console.log(`  MIGRATED (disk): ${sessionId} → "${newName}"`);
      }

      migrated++;
    } catch (err) {
      console.error(`  ERROR: ${sessionDir} - ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone! Migrated: ${migrated}, Errors: ${errors}`);
}

migrate().catch(console.error);
