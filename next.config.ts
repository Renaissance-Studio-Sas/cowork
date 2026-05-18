import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Agent SDK + better-sqlite3 are Node-only; keep them out of the client bundle
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "better-sqlite3", "chokidar"],
};

export default nextConfig;
