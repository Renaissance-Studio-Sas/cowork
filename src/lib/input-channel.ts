import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// A pushable AsyncIterable used as the `prompt` arg for query().
// We push new user messages into it as they arrive over HTTP.
export class InputChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: message, done: false });
    else this.queue.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}

export function makeUserMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  } as SDKUserMessage;
}
