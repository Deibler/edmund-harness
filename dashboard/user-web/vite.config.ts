import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The USER portal — the page a person opens from their standing /u/<key>/<token>
 * link. Built to dist/ and served by the dashboard's public listener:
 *   /u/:key/:token         → dist/index.html
 *   /portal/assets/*       → dist/assets/*  (hence `base`)
 *   /u/:key/:token/data    → the page's JSON (routes/portal.ts)
 * In dev, `vite` proxies those two prefixes to the local dashboard.
 */
export default defineConfig({
  base: "/portal/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@api": path.resolve(__dirname, "../server"),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/u": { target: "http://localhost:4749", changeOrigin: true },
      "/brand": { target: "http://localhost:4749", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
