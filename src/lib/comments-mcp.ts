// In-process MCP server that exposes the workbench's comments to the agent.
// One instance per session — it closes over the session's project/task so the
// agent can call `list_comments(file_path)`, `resolve_comment(id)`, and
// `add_comment(file_path, quote, body)` without specifying project/task.

import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { addComment, deleteComment, listComments } from "./comments-store";

export function buildCommentsMcp(projectSlug: string, taskSlug: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "workbench-comments",
    version: "0.1.0",
    tools: [
      tool(
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

      tool(
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

      tool(
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
    ],
  });
}
