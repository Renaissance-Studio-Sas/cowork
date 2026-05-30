import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Vite config for LOCAL DEV against the Node backend (src/server). Unlike the
// default vite.config.ts (which loads @cloudflare/vite-plugin to run/build the
// Worker), this is a plain React + Tailwind client dev server that proxies
// /api/* to the Node Hono server. This gives HMR on the client while the API
// runs the real local fs/agent logic on Node — and sidesteps the miniflare
// loopback crash the Cloudflare dev plugin hits in some setups.
//
// Used by `npm run dev` alongside `npm run dev:server`.
const API_PORT = process.env.API_PORT || "8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 3100,
    proxy: {
      // Forward API + SSE to the Node server. ws:false — these are HTTP/SSE,
      // not websockets. configure.proxyTimeout disabled so long-lived SSE
      // streams aren't cut off.
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
      },
    },
  },
});
