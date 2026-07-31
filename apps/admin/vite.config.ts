import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/client",
  server: {
    port: 2312,
    strictPort: true,
    proxy: {
      // apps/admin has no worker of its own (issue #8: "apps/admin talks to
      // the same worker API"). In dev, apps/web's Vite dev server (port
      // 2311) runs that worker in-process via its own devApiProxy plugin;
      // this just forwards /api/* there so cookies set by /api/auth/*
      // round-trip correctly against http://localhost:2312.
      "/api": {
        target: "http://localhost:2311",
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 2312,
    strictPort: true,
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
});
