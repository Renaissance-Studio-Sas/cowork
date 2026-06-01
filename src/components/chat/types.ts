// Shared types for the chat UI. SDKMessageLite is the persisted message shape
// the SSE stream and history endpoint emit — a structurally-loose mirror of
// the Claude Agent SDK's SDKMessage that the renderer can pattern-match on
// `type` and dig into `message.content` without a full type dependency on
// the SDK.

export type SDKMessageLite =
  | { type: "user"; message: { role: "user"; content: unknown }; uuid?: string }
  | {
      type: "assistant";
      message: {
        role: "assistant";
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
      };
      uuid?: string;
    }
  | { type: "result"; subtype: string; uuid?: string }
  | { type: "system"; subtype: string }
  | Record<string, unknown>;

// claude.ai subscription usage snapshot, mirrored from the SDK's
// SDKRateLimitInfo (carried on `rate_limit_event`, forwarded over SSE as a
// `rate_limit` event). Drives the small usage indicator below the composer.
export interface RateLimitInfoLite {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
  utilization?: number; // 0–1 fraction of the window consumed
}

export interface PendingQuestionItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}

// One element of an assistant message's `content` array. Loose by design —
// every consumer pattern-matches on `type` and casts the relevant fields.
export type Part = { type: string; [k: string]: unknown };
