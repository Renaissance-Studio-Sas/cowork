import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Node-only packages — don't bundle for the client; require at runtime.
  // gemini-cli-core transitively pulls in @lydell/node-pty (native pty for
  // its interactive shell tool) which Turbopack chokes on. Listing the
  // package as external short-circuits the bundler.
  serverExternalPackages: [
    "@anthropic-ai/claude-agent-sdk",
    "@google/gemini-cli-core",
    "better-sqlite3",
    "chokidar",
    // server-only; we attach over CDP, no bundled browser
    "playwright-core",
  ],
};

export default nextConfig;
