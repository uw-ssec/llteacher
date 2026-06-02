import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { randomUUID } from "node:crypto";

// Dev-only middleware that handles /api/* without going through the Worker.
// Production deploys still use the Hono Worker in src/server/. Remove this
// plugin or gate it on an env flag once @cloudflare/vite-plugin routing works
// end-to-end locally.
const devApiStub: Plugin = {
  name: "llteacher-dev-api-stub",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/api/hello", (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          message: "Hono Worker is alive. (dev stub from Vite — provision Neon to hit the real route)",
          ping_id: randomUUID(),
        }),
      );
    });
  },
};

export default defineConfig({
  root: "src/client",
  server: {
    port: 2311,
    strictPort: true,
  },
  preview: {
    port: 2311,
    strictPort: true,
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  plugins: [devApiStub, react(), tailwindcss(), cloudflare()],
});
