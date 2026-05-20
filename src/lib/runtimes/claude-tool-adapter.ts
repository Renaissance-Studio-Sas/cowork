// Wraps an array of WorkbenchTool entries as a Claude SDK MCP server.
// Claude SDK only knows how to consume custom tools via MCP — there's no
// `customTools: [...]` field on the query options — so we use
// createSdkMcpServer + tool() under the hood. The MCP wrapping is an
// implementation detail confined to this adapter; tool *authors* don't
// see it.

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { WorkbenchTool } from "../workbench-tools/types";

export function workbenchToolsAsClaudeMcp(
  name: string,
  workbenchTools: WorkbenchTool[],
  version = "0.1.0",
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name,
    version,
    tools: workbenchTools.map((t) =>
      tool(
        t.name,
        t.description,
        // Claude SDK's tool() expects a zod RAW shape — same shape we
        // accept on WorkbenchTool.schema, so this is identity.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        t.schema as any,
        // The MCP SDK's CallToolResult has a `[key: string]: unknown` index
        // signature that our ToolCallResult deliberately doesn't (cleaner
        // public type); cast at the boundary.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (args: Record<string, unknown>) => (await t.handler(args)) as any,
      ),
    ),
  });
}
