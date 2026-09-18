import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/* #368: matches the Node server's COOP/COEP headers. Vite serves pages and
   static assets itself during development, while `/api/*` proxies to the
   separately running Node API server. */
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
    proxy: {
      "/api": {
        target: process.env.NODE_API_URL ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 2311,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
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
