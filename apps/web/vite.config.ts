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
          // Set-Cookie is forwarded separately below -- Headers.forEach
          // yields one call per cookie (never comma-joined), but Node's
          // setHeader replaces rather than appends on repeat calls with a
          // string value, so a second Set-Cookie here would silently drop
          // the first (e.g. the OAuth state + PKCE verifier cookies set
          // together by /api/auth/login).
          if (key.toLowerCase() === "set-cookie") return;
          res.setHeader(key, value);
        });
        const setCookies = response.headers.getSetCookie?.() ?? [];
        if (setCookies.length > 0) {
          res.setHeader("set-cookie", setCookies);
        }

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
        console.error("[dev-api-proxy] error:", err);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  },
};

/* #368: matches server/index.ts's own COOP/COEP
   middleware -- see that file's comment for the full reasoning. Needed here
   too because dev mode serves the page and static assets directly through
   Vite's own server, not through the Hono app (only /api/* goes through
   devApiProxy above); in production everything -- including these same
   headers -- goes through the one Hono app instead. */
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
  },
  preview: {
    port: 2311,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    /* Client-environment ONLY. `build.rollupOptions` at this level is Vite 6's
       default for EVERY environment, and manualChunks is invalid in an SSR or
       Worker build -- Rollup hard-fails with either "cannot be included in
       manualChunks because it is resolved as an external module" or "not
       supported for output.inlineDynamicImports", depending on whether deps
       are externalised. It happens to be harmless today only because
       @cloudflare/vite-plugin never discovers wrangler.jsonc (Vite `root` is
       src/client) so no worker environment is built, and the real Worker is
       bundled by `wrangler deploy` outside Vite entirely. The comment at the
       top of this file states the intent to remove the dev proxy once the
       Cloudflare plugin handles /api/* end-to-end -- at that moment a
       top-level manualChunks would break the build with an error naming
       neither this file nor the client build. Scoped now, while the reason is
       still written down. */
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          output: {
            /* KaTeX is ~290 kB and changes only on dependency upgrade, whereas
               app code changes every deploy. Left in the main chunk, every
               deploy invalidates it for every returning student; split out, it
               is fetched once and cached.

               It stays a STATIC import rather than a lazy one on purpose: the
               transcript hydrates persisted history on first paint, so lazily
               loaded KaTeX would render raw \(...\) for a frame -- reproducing
               the exact bug this was added to fix. Chunking gets the caching
               win without that flash. */
            manualChunks: {
              katex: ["katex", "rehype-katex"],
            },
          },
        },
      },
    },
  },
  plugins: [devApiProxy, react(), tailwindcss(), cloudflare()],
});
