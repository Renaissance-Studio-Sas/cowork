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

import { z, toJSONSchema } from "zod";
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
      // { type: 'object', properties: {...}, required: [...] }. zod v4's
      // built-in toJSONSchema produces exactly this — we just strip the
      // `$schema` URL and `additionalProperties` (gemini-cli-core's
      // function-call parser is happy without either).
      //
      // NOTE: the older zod-to-json-schema package silently returned `{}`
      // for zod v4 inputs (was authored against zod v3 internals). That
      // caused tools to be registered with no usable schema, and Gemini
      // rejected calls with "Model stream ended with malformed function
      // call." Using z's own toJSONSchema fixes it.
      stripJsonSchemaWrapper(toJSONSchema(z.object(workbenchTool.schema as z.ZodRawShape))),
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

// Sanitize a JSON Schema for Gemini's function-call parser. Strips fields
// that aren't part of OpenAPI 3.0 (which is the subset Gemini accepts in
// FunctionDeclaration.parameters per the Vertex API docs). The Gemini API
// returns finishReason="MALFORMED_FUNCTION_CALL" when given unsupported
// constructs like $schema, additionalProperties, oneOf/anyOf/allOf at root,
// or schemas wrapped in $ref/definitions. We recurse so nested properties
// (e.g. array items) are also sanitized.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripJsonSchemaWrapper(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  // Resolve top-level $ref into definitions if present.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: any = schema;
  if (schema.$ref && schema.definitions) {
    const refPath = String(schema.$ref).replace(/^#\/definitions\//, "");
    if (schema.definitions[refPath]) {
      resolved = schema.definitions[refPath];
    }
  }
  return sanitizeForGemini(resolved);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeForGemini(schema: any): any {
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini);
  if (!schema || typeof schema !== "object") return schema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(schema)) {
    // Drop fields Gemini's function-call parser doesn't accept.
    if (k === "$schema" || k === "$id" || k === "$ref" || k === "definitions") continue;
    if (k === "additionalProperties") continue;
    out[k] = sanitizeForGemini(v);
  }
  return out;
}
