// WorkbenchTool — cowork's neutral tool descriptor. Each workbench-tools/
// file exports an array of these. Per-runtime adapters in
// src/lib/runtimes/*-tool-adapter.ts convert into the runtime's native
// shape (Claude wraps as a createSdkMcpServer MCP because Claude SDK
// requires it; Gemini registers into gemini-cli-core's ToolRegistry; future
// Codex maps to OpenAI function-call shape).
//
// The shape is intentionally close to MCP's tool descriptor (name +
// description + zod-shape inputSchema + handler returning CallToolResult)
// because both runtime SDKs already speak that vocabulary — it minimizes
// translation tax at the boundaries. We don't depend on Claude SDK or
// gemini-cli-core for the type itself, so a Codex-only deployment could
// still author workbench tools without either installed.

import type { z } from "zod";

// Mirror of MCP's CallToolResult content shape — what tool handlers
// return. Plain TS so it doesn't pull a transitive import.
export interface ToolCallContentText {
  type: "text";
  text: string;
}

export interface ToolCallContentImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type ToolCallContent = ToolCallContentText | ToolCallContentImage;

export interface ToolCallResult {
  content: ToolCallContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

// Zod raw shape: `{ field: z.string(), other: z.number() }`. This is what
// Claude SDK's tool() helper and gemini-cli-core both accept for input
// schema; an MCP server reflects it as a JSON Schema at registration time.
export type ToolSchema = z.ZodRawShape;

// The stored WorkbenchTool shape uses `args: unknown` so a heterogeneous
// array (WorkbenchTool[]) is well-typed. defineTool() below preserves the
// schema-typed args at the call site for ergonomics — but the schema is
// also the runtime source of truth, so the handler can re-parse defensively
// if it wants to.
export interface WorkbenchTool {
  name: string;
  description: string;
  schema: ToolSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<ToolCallResult>;
}

// Helper that infers the handler's args type from the schema at the call
// site, then widens to the stored WorkbenchTool shape. This is the standard
// pattern when you want both ergonomic per-tool typing and a uniform
// container type. The runtime adapters route handler invocations through
// the original (narrowly-typed) function, so the type narrowing isn't lost
// — it's just hidden from the array element type.
export function defineTool<S extends ToolSchema>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolCallResult>,
): WorkbenchTool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { name, description, schema, handler: handler as (args: any) => Promise<ToolCallResult> };
}
