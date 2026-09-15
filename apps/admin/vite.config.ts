import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "/admin/",
  root: "src/client",
  server: {
    port: 2312,
    strictPort: true,
    proxy: {
      // apps/admin shares the Node API with the web SPA. In development,
      // apps/web's Vite server (port 2311) proxies this request onward to the
      // Node server; this hop keeps browser cookies same-origin at 2312.
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
    outDir: "../../dist/admin",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
});
