import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/client",
  server: {
    port: 2312,
    strictPort: true,
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
