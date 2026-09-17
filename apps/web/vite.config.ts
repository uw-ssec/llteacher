import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The top-level document needs these headers for WebR's shared-memory channel.
const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: "src/client",
  server: {
    port: 2311,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
    proxy: { "/api": { target: process.env.LLTEACHER_API_URL ?? "http://localhost:8080", changeOrigin: false } },
  },
  preview: {
    port: 2311,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            // Keep stable math assets cached across application deployments.
            manualChunks: { katex: ["katex", "rehype-katex"] },
          },
        },
      },
    },
  },
  plugins: [react(), tailwindcss()],
});
