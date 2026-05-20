// Registers WorkbenchTool[] arrays into gemini-cli-core's ToolRegistry so
// Gemini sessions can call them. Each WorkbenchTool becomes a small
// subclass of BaseDeclarativeTool + BaseToolInvocation that delegates to
// the workbench tool's handler. The zod RAW shape is converted to JSON
// Schema (gemini-cli-core wants JSON Schema, not zod, for the
// parameterSchema field).
//
// Bypasses MCP entirely on the Gemini side — the McpClient in
// gemini-cli-core only accepts external transports (stdio/sse/http), and
// our workbench tools are pure in-process functions. Plugging in at the
// ToolRegistry layer is the cleanest match.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type Config,
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ExecuteOptions,
  type MessageBus,
} from "@google/gemini-cli-core";
import type { WorkbenchTool, ToolCallResult } from "../workbench-tools/types";

type AnyParams = Record<string, unknown>;

class WorkbenchToolInvocation extends BaseToolInvocation<AnyParams, ToolResult> {
  constructor(
    params: AnyParams,
    messageBus: MessageBus,
    private readonly workbenchTool: WorkbenchTool,
  ) {
    super(params, messageBus);
  }

  getDescription(): string {
    return `${this.workbenchTool.name}: ${this.workbenchTool.description.split("\n")[0].slice(0, 120)}`;
  }

  async execute(_options: ExecuteOptions): Promise<ToolResult> {
    const result: ToolCallResult = await this.workbenchTool.handler(this.params);
    // Translate workbench ToolCallResult → gemini-cli-core ToolResult.
    // llmContent goes to the model (for the next turn's context);
    // returnDisplay is the user-visible Markdown summary.
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return {
      llmContent: text,
      returnDisplay: text,
      ...(result.isError ? { error: { message: text, type: "WorkbenchToolError" } } : {}),
    } as unknown as ToolResult;
  }
}

class WorkbenchToolClass extends BaseDeclarativeTool<AnyParams, ToolResult> {
  constructor(
    private readonly workbenchTool: WorkbenchTool,
    messageBus: MessageBus,
  ) {
    super(
      workbenchTool.name,
      workbenchTool.name,
      workbenchTool.description,
      // Most workbench tools are reads/mutations of cowork's own state, not
      // file/network ops. Kind.Other is the safe catch-all; if specific
      // tools want a different kind (e.g. add_comment as Kind.Edit) we can
      // add a per-tool override later.
      Kind.Other,
      // gemini-cli-core wants a clean JSON Schema for parameterSchema:
      // { type: 'object', properties: {...}, required: [...] }. Bare —
      // no $schema, no top-level $ref, no definitions wrapper. zod-to-
      // json-schema's default output adds those, which makes Gemini's
      // function-call parser reject the tool with "Model stream ended
      // with malformed function call." So we strip the schema wrapper.
      // The type mismatch (zod v4 here vs zod v3 in zod-to-json-schema)
      // is bridged with `any` casts — runtime output is JSON Schema
      // regardless of which zod the input came from.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stripJsonSchemaWrapper(zodToJsonSchema(z.object(workbenchTool.schema as z.ZodRawShape) as any) as any),
      messageBus,
    );
  }

  protected createInvocation(params: AnyParams): ToolInvocation<AnyParams, ToolResult> {
    return new WorkbenchToolInvocation(params, this.messageBus, this.workbenchTool);
  }
}

// Register a batch of WorkbenchTools into a gemini-cli-core Config's
// ToolRegistry. Call this AFTER config.initialize(), which is when the
// registry exists.
export function registerWorkbenchToolsInGemini(config: Config, tools: WorkbenchTool[]): void {
  const registry = config.getToolRegistry();
  const messageBus = config.getMessageBus();
  for (const t of tools) {
    registry.registerTool(new WorkbenchToolClass(t, messageBus));
  }
}

// zod-to-json-schema emits a wrapped schema with `$schema`,
// optional `definitions`, and sometimes a top-level `$ref`. gemini-cli-core
// (and the underlying Gemini function-call parser) expects a flat
// `{ type: 'object', properties, required }`. Strip the wrapper here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripJsonSchemaWrapper(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  // Inline the top-level $ref if present (zod-to-json-schema sometimes
  // emits `{ $ref: "#/definitions/X", definitions: { X: {...} } }`).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: any = schema;
  if (schema.$ref && schema.definitions) {
    const refPath = String(schema.$ref).replace(/^#\/definitions\//, "");
    if (schema.definitions[refPath]) {
      resolved = schema.definitions[refPath];
    }
  }
  // Strip JSON-Schema metadata that Gemini's parser doesn't want.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema: _$schema, definitions: _definitions, ...rest } = resolved;
  return rest;
}
