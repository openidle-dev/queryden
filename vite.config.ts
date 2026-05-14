import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

import pkg from "./package.json";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  define: {
    '__APP_VERSION__': JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Group any monaco-editor code we actually import (and the React
          // wrapper) into a single lazy chunk. The leading `vs/` check is
          // intentional: it matches our slim `monaco-editor/esm/vs/editor/...`
          // imports without naming the package as an entry — naming the
          // bare `monaco-editor` package here would pull `editor.main.js`
          // into the graph and re-include every basic-language Monarch +
          // the JSON/TS/CSS/HTML language services and their workers.
          if (id.includes("/monaco-editor/") || id.includes("/@monaco-editor/")) {
            return "monaco";
          }
          if (id.includes("/@glideapps/glide-data-grid/")) {
            return "grid";
          }
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/lucide-react/") ||
            id.includes("/node_modules/zustand/")
          ) {
            return "vendor";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));