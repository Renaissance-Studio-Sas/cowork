// JSON logging to STDERR — stdout is reserved for the MCP protocol on stdio
// transport, so we must not pollute it.

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  });
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};
