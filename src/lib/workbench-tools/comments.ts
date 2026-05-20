// Workbench tools for the comments panel: list_comments, resolve_comment,
// add_comment, edit_comment. One builder per session — closes over the
// session's project/task so the agent doesn't have to specify them on
// every call. Per-runtime adapters in src/lib/runtimes/ wrap as MCP for
// Claude or register into gemini-cli-core's ToolRegistry for Gemini.

import { z } from "zod";
import { addComment, deleteComment, listComments, updateComment } from "../comments-store";
import { defineTool, type WorkbenchTool } from "./types";

export function buildCommentsTools(projectSlug: string, taskSlug: string): WorkbenchTool[] {
  return [
    defineTool(
      "list_comments",
      "List comments on a file in the current task. Use this to read what the user wants addressed. Returns an array of {id, file_path, quote, body, author, created_at, resolved}. Pass an empty string for file_path to list comments across the whole task.",
      { file_path: z.string() },
      async ({ file_path }) => {
        const rows = await listComments(projectSlug, taskSlug, file_path || undefined);
        const out = rows.map((r) => ({
          id: r.id,
          file_path: r.filePath,
          quote: r.anchor?.exact ?? r.anchor?.quote ?? null,
          body: r.body,
          author: r.author,
          created_at: r.createdAt,
          resolved: !!r.resolvedAt,
        }));
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      },
    ),

    defineTool(
      "resolve_comment",
      "Resolve a comment after you have addressed it. This deletes the comment from the user's view so they know it's been handled. Call this immediately after fixing the document text the comment was attached to.",
      { comment_id: z.number().int() },
      async ({ comment_id }) => {
        const removed = await deleteComment(projectSlug, taskSlug, comment_id);
        if (!removed) {
          return {
            content: [{ type: "text", text: `No comment with id ${comment_id} in this task.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Resolved comment ${comment_id} ("${removed.body.slice(0, 60)}").` }],
        };
      },
    ),

    defineTool(
      "add_comment",
      "Add a new comment on a file in the current task. Use this to flag things for the user — questions, observations, items to review. Pass the exact visible text the comment attaches to in `quote` (the UI will highlight that span). Use an empty string for `quote` to comment on the whole document.",
      {
        file_path: z.string(),
        quote: z.string(),
        body: z.string(),
      },
      async ({ file_path, quote, body }) => {
        const anchor = quote ? { prefix: "", exact: quote, suffix: "" } : {};
        const created = await addComment(projectSlug, taskSlug, {
          filePath: file_path,
          anchorType: file_path.endsWith(".html") || file_path.endsWith(".htm") ? "html" : "md",
          anchor,
          body,
          author: "agent",
        });
        return {
          content: [{ type: "text", text: `Added comment ${created.id} on ${file_path}.` }],
        };
      },
    ),

    defineTool(
      "edit_comment",
      "Edit the body of an existing comment. Use this to update a comment you previously made, for example to add more information or correct a mistake.",
      {
        comment_id: z.number().int(),
        body: z.string(),
      },
      async ({ comment_id, body }) => {
        const updated = await updateComment(projectSlug, taskSlug, comment_id, body);
        if (!updated) {
          return {
            content: [{ type: "text", text: `No comment with id ${comment_id} in this task.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Updated comment ${comment_id}.` }],
        };
      },
    ),
  ];
}
