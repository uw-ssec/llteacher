import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/client",
  server: {
    port: 2312,
    strictPort: true,
    proxy: {
      // Both SPAs use the same Node API and preserve the browser origin.
      "/api": {
        target: process.env.LLTEACHER_API_URL ?? "http://localhost:8080",
        changeOrigin: false,
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
