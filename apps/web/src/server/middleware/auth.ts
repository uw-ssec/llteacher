import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  SESSION_COOKIE_NAME,
  loadSessionKey,
  unsealSession,
  type SessionPayload,
} from "../../lib/session";
import type { AppEnv } from "../context";

/** Routes under these prefixes never require a session. */
const PUBLIC_API_PREFIXES = ["/api/auth/"];

export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const session = await extractSession(c);
  if (session) {
    c.set("session", session);
  }

  const path = c.req.path;
  const isApiRoute = path.startsWith("/api/");
  const isPublicApiRoute = PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix));
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
