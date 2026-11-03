import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * A page Edmund builds for one person (src/ideation/). It ships as ONE file,
 * dist/index.html, with every script, style, font and image inlined: the
 * kitchen host serves it read from disk on each open, nothing runs until
 * someone taps the link, and the page's sandbox (no network) cannot fetch
 * anything later anyway. Map tiles and remote images load as plain <img>.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
  },
});
