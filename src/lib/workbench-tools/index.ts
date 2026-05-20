// Workbench tools — runtime-agnostic tool definitions for cowork's
// in-process agent capabilities (comments, planning, email, session
// management, Chrome bridge inspection). Authored as pure WorkbenchTool[]
// arrays; per-runtime adapters in src/lib/runtimes/ wrap them at
// registration time:
//   - Claude: wraps as a createSdkMcpServer MCP (Claude SDK requires it)
//   - Gemini: registers into gemini-cli-core's ToolRegistry
//
// To add a new workbench tool: pick the right file (or create a new one),
// append a defineTool(...) entry, done — both runtimes pick it up.

export { defineTool, type WorkbenchTool, type ToolCallResult, type ToolCallContent, type ToolSchema } from "./types";
export { buildCommentsTools } from "./comments";
export { buildPlanningTools, PLANNING_SYSTEM_PROMPT } from "./planning";
export { buildSessionTools } from "./session";
