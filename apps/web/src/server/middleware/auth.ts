import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  SESSION_COOKIE_NAME,
  loadSessionKey,
  unsealSession,
  type SessionPayload,
} from "../../lib/session";
import type { AppEnv } from "../context";

/** Exact paths that never require a session. Deliberately a closed set
 *  (not a prefix match) -- a new /api/auth/* endpoint must be added here
 *  explicitly, so it can't silently become public by sharing the prefix. */
const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/logout",
]);

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const session = await extractSession(c);
  if (session) {
    c.set("session", session);
  }

  const path = c.req.path;
  const isApiRoute = path.startsWith("/api/");
  const isPublicApiRoute = PUBLIC_API_PATHS.has(path);
  if (isApiRoute && !isPublicApiRoute && !session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}

export async function extractSession(c: Context<AppEnv>): Promise<SessionPayload | null> {
  const cookieValue = getCookie(c, SESSION_COOKIE_NAME);
  if (!cookieValue) return null;
  const key = await loadSessionKey(c.env);
  return unsealSession(cookieValue, key);
}
