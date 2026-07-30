import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

/* --------------------------------------------------------------------------
   Dev API proxy — runs the actual Hono Worker code in Vite's Node process
   for /api/* requests.

   Why: @cloudflare/vite-plugin's Worker routing isn't reliably wiring
   /api/* to the Worker in dev mode (returns 404). This proxy loads the
   Hono app via Vite's SSR module loader, parses .dev.vars manually for
   env bindings, converts Node's IncomingMessage <-> Web Request/Response,
   and streams the result back. Production deploys are unaffected — they
   run the real Worker on Cloudflare.

   Remove this plugin once the Cloudflare Vite plugin handles /api/*
   routing end-to-end in dev.
   -------------------------------------------------------------------------- */

function loadDevVars(rootDir: string): Record<string, string> {
  const devVarsPath = path.resolve(rootDir, ".dev.vars");
  if (!existsSync(devVarsPath)) return {};
  const content = readFileSync(devVarsPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const devApiProxy: Plugin = {
  name: "llteacher-dev-api-proxy",
  apply: "serve",
  configureServer(server) {
    /* Resolve .dev.vars relative to the workspace root (the dir containing
       package.json / wrangler.jsonc), not Vite's `root` (src/client/). */
    const workspaceRoot = path.resolve(import.meta.dirname);

    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/api/")) return next();

      try {
        const env = {
          ...loadDevVars(workspaceRoot),
          /* Stub ASSETS binding so the Worker's `app.all("*")` catch-all
             doesn't blow up if a request misses every /api/* route. */
          ASSETS: {
            fetch: async () =>
              new Response("Not Found (dev API proxy)", { status: 404 }),
          },
        };

        /* Build a Web Request from the Node IncomingMessage. */
        const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
        const method = req.method ?? "GET";
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k] = v;
        }

        let body: ReadableStream | undefined;
        if (method !== "GET" && method !== "HEAD") {
          body = Readable.toWeb(req) as ReadableStream;
        }

        const request = new Request(url, {
          method,
          headers,
          body,
          /* `duplex: 'half'` is required by fetch spec when body is a stream */
          ...(body ? { duplex: "half" } : {}),
        } as RequestInit & { duplex?: string });

        /* Load the Hono app via Vite SSR. The relative path is resolved
           against the Vite `root` (src/client/), so we use ../server/index.ts. */
        const mod = await server.ssrLoadModule("../server/index.ts");
        const app = mod.default;

        const response: Response = await app.fetch(request, env);

        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        if (!response.body) {
          res.end();
          return;
        }

        const reader = response.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[dev-api-proxy] error:", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
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
  plugins: [devApiProxy, react(), tailwindcss(), cloudflare()],
});
