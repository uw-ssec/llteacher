import { Hono } from "hono";
import { helloHandler } from "./routes/hello";
import { chatHandler } from "./routes/chat";
import { loginHandler, callbackHandler, logoutHandler } from "./routes/auth";
import { authMiddleware } from "./middleware/auth";
import type { AppEnv } from "./context";

const app = new Hono<AppEnv>();

// Session gate for every /api/* route except /api/auth/*.
app.use("/api/*", authMiddleware);

// API routes — registered directly on `app` rather than via app.route(prefix, sub)
// to avoid Hono's prefix-stripping behavior that can cause /api/hello to not
// match a sub-app's `/` handler.
app.get("/api/hello", helloHandler);
app.post("/api/chat", chatHandler);
app.get("/api/auth/login", loginHandler);
app.get("/api/auth/callback", callbackHandler);
app.post("/api/auth/logout", logoutHandler);

// Everything else: delegate to the static asset binding.
// In dev, this proxies to Vite's pipeline (so HMR + source maps work).
// In prod, it serves built assets, falling back to index.html for SPA routes
// per the `not_found_handling: "single-page-application"` setting in wrangler.jsonc.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
