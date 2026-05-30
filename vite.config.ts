import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

// Vite drives the React SPA (client) and bundles the Hono Worker (server).
// The Cloudflare plugin runs the Worker in-process during `vite dev` and emits
// a Workers-compatible build that `wrangler deploy` ships alongside the static
// assets. Tailwind v4 is wired through its first-class Vite plugin (no PostCSS).
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
