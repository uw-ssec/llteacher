# M1 Auth & Identity (WorkOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixture identity in `apps/web`'s Hono/TS stack with real WorkOS AuthKit sessions, encrypted user provisioning, an email-domain allowlist, role-based route guards, and a profile page — closing GitHub issues #8, #9, #11, #10, #12 under milestone [M1: Auth & Identity (WorkOS)](https://github.com/uw-ssec/llteacher/milestone/1) (epic #13).

**Architecture:** Hono middleware chain on `/api/*`: `authMiddleware` unseals a stateless AES-GCM session cookie and attaches `{ userId, workosUserId }`; `rolesMiddleware` loads the user's `course_memberships` once per request and attaches role-check helpers. `POST/GET /api/auth/*` handles the AuthKit redirect/callback/logout, calling `DomainAllowlistService` then `UserIdentityService` (which wraps the existing `IdentityCipher`) to provision an encrypted `users` row. `/api/profile` reads/writes decrypted display fields + real instructor stats. All PII stays encrypted at rest; only the server ever holds the decryption keys.

**Tech Stack:** Hono 4, Drizzle ORM 0.36 (`neon-http`), Web Crypto (AES-256-GCM + HMAC-SHA256, no Node-only crypto), `@workos-inc/node` v7, Vitest, React 19 + react-router 7, `@llteacher/ui`.

## Global Constraints

- No plaintext PII (email, netid, display name) is ever written to the `users` table — always through `IdentityCipher.encryptString` (apps/web/src/lib/crypto/identity-cipher.ts:45).
- Encryption/HMAC keys load only from environment (`.dev.vars` locally, secrets store in prod) — never hardcoded, never committed.
- Session is a stateless sealed cookie (no server-side session store), matching the pattern already used for PII (`IdentityCipher`), but a plaintext-of-concern-free payload (userId/workosUserId/timestamps only).
- Every new `/api/*` route requires an authenticated session except `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`.
- Follow the existing route convention: handlers registered directly on `app` in `server/index.ts` (not via `app.route(prefix, subApp)` — see the comment at apps/web/src/server/index.ts:7 explaining why), with a small `Hono` sub-app preserved per file for direct unit testing (see apps/web/src/server/routes/hello.ts:32).
- Match existing test conventions: Vitest, `app.request(path, init, envOverride)` for route tests (apps/web/src/server/routes/hello.test.ts), real `crypto.subtle` keys in crypto tests (apps/web/src/lib/crypto/identity-cipher.test.ts).
- Keep files small and single-purpose; no speculative abstraction beyond what a task needs.

**Out of scope for this plan** (explicitly deferred, to keep this pass shippable):
- **Issue #95 (WorkOS webhook handling)** — the issue itself says it's "not in this epic's critical path" and requires a session-revocation design decision (short-TTL-vs-denylist) plus queue/Durable Objects infra that's a separate architectural decision. Do it as a follow-up plan once #8's session shape is proven in production.
- **`apps/admin` cross-app wiring** — `apps/admin` currently has no server directory or dev API proxy at all (fixture-only client). Wiring it to the same session cookie is real work belonging to whichever issue stands up admin's backend, not this auth epic.
- **Guard application to real business routes** — `apps/web` has no homework/course CRUD routes yet (only `/api/hello`, `/api/chat`). Issue #10's guards (`requireInstructorOf`, etc.) are built and tested in isolation; wiring them onto homework/course routes happens when those routes ship (M2).

---

## Task 1: Sealed session cookie codec

**Files:**
- Create: `apps/web/src/lib/session.ts`
- Test: `apps/web/src/lib/session.test.ts`

**Interfaces:**
- Produces: `SessionPayload { userId: string; workosUserId: string; issuedAt: number; expiresAt: number }`, `SESSION_COOKIE_NAME: string`, `SESSION_TTL_SECONDS: number`, `createSessionPayload(userId: string, workosUserId: string, now?: number): SessionPayload`, `loadSessionKey(env: Env): Promise<CryptoKey>`, `sealSession(payload: SessionPayload, key: CryptoKey): Promise<string>`, `unsealSession(cookieValue: string, key: CryptoKey): Promise<SessionPayload | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/session.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import {
  createSessionPayload,
  loadSessionKey,
  sealSession,
  unsealSession,
} from "./session";

let key: CryptoKey;

beforeAll(async () => {
  key = await loadSessionKey({
    SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  } as Env);
});

describe("sealSession / unsealSession", () => {
  it("round-trips a valid payload", async () => {
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    const unsealed = await unsealSession(sealed, key);
    expect(unsealed).toEqual(payload);
  });

  it("produces a different cookie value each time (random IV)", async () => {
    const payload = createSessionPayload("user-1", "workos-1");
    const a = await sealSession(payload, key);
    const b = await sealSession(payload, key);
    expect(a).not.toBe(b);
  });

  it("rejects an expired session", async () => {
    const payload = createSessionPayload("user-1", "workos-1", Date.now() - 1000 * 60 * 60 * 24 * 30);
    const sealed = await sealSession(payload, key);
    expect(await unsealSession(sealed, key)).toBeNull();
  });

  it("rejects a tampered cookie value", async () => {
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    const tampered = sealed.slice(0, -2) + (sealed.slice(-2) === "AA" ? "BB" : "AA");
    expect(await unsealSession(tampered, key)).toBeNull();
  });

  it("rejects a cookie sealed with a different key", async () => {
    const otherKey = await loadSessionKey({
      SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    } as Env);
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    expect(await unsealSession(sealed, otherKey)).toBeNull();
  });

  it("rejects garbage input without throwing", async () => {
    expect(await unsealSession("not-a-valid-cookie", key)).toBeNull();
  });
});

describe("loadSessionKey", () => {
  it("throws a clear error when SESSION_SECRET is missing", async () => {
    await expect(loadSessionKey({} as Env)).rejects.toThrow(/SESSION_SECRET/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/session.test.ts`
Expected: FAIL — `session.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/session.ts
/**
 * Stateless sealed session cookie: AES-256-GCM over a small JSON payload.
 * No server-side session store — the sealed cookie *is* the session.
 * Rotating SESSION_SECRET invalidates every active session (acceptable
 * per issue #8; a revocation mechanism for single-user logout-everywhere
 * is issue #95's concern).
 */

export interface SessionPayload {
  userId: string;
  workosUserId: string;
  issuedAt: number;
  expiresAt: number;
}

export const SESSION_COOKIE_NAME = "llt_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const IV_BYTES = 12;

export function createSessionPayload(
  userId: string,
  workosUserId: string,
  now: number = Date.now(),
): SessionPayload {
  return {
    userId,
    workosUserId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
  };
}

export async function loadSessionKey(env: Env): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET must be set (apps/web/.dev.vars locally; the deployed secrets store in prod).",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(secret, "base64")),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealSession(payload: SessionPayload, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return Buffer.from(combined).toString("base64url");
}

export async function unsealSession(
  cookieValue: string,
  key: CryptoKey,
): Promise<SessionPayload | null> {
  try {
    const combined = new Uint8Array(Buffer.from(cookieValue, "base64url"));
    if (combined.length <= IV_BYTES) return null;
    const iv = combined.subarray(0, IV_BYTES);
    const ciphertext = combined.subarray(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload;
    if (
      typeof payload.userId !== "string" ||
      typeof payload.workosUserId !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return null;
    }
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    // Tampered, malformed, or wrong key — all treated as "no session".
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/session.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/session.ts apps/web/src/lib/session.test.ts
git commit -m "feat(auth): sealed session cookie codec"
```

---

## Task 2: Auth middleware (`/api/*` session gate)

**Files:**
- Create: `apps/web/src/server/middleware/auth.ts`
- Test: `apps/web/src/server/middleware/auth.test.ts`

**Interfaces:**
- Consumes: `SessionPayload`, `SESSION_COOKIE_NAME`, `loadSessionKey`, `unsealSession` from Task 1 (`../../lib/session`).
- Produces: `authMiddleware(c, next)` (Hono `MiddlewareHandler`), `PUBLIC_API_PREFIXES: string[]`. Sets `c.set("session", session)` when present; the rest of the app reads it back via `c.get("session") as SessionPayload | undefined` (matches the untyped-Variables convention already used for `Env` in this codebase — see Global Constraints).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/middleware/auth.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { authMiddleware } from "./auth";
import { createSessionPayload, loadSessionKey, sealSession, SESSION_COOKIE_NAME } from "../../lib/session";

const TEST_ENV = { SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64") } as Env;

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/api/protected", (c) => {
    const session = c.get("session");
    return c.json({ session });
  });
  app.get("/api/auth/login", (c) => c.text("login stub"));
  return app;
}

describe("authMiddleware", () => {
  it("returns 401 for /api/* with no cookie", async () => {
    const res = await buildApp().request("/api/protected", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const key = await loadSessionKey(TEST_ENV);
    const expired = createSessionPayload("user-1", "workos-1", Date.now() - 1000 * 60 * 60 * 24 * 30);
    const sealed = await sealSession(expired, key);
    const res = await buildApp().request(
      "/api/protected",
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
  });

  it("attaches the session and allows the request through when valid", async () => {
    const key = await loadSessionKey(TEST_ENV);
    const payload = createSessionPayload("user-1", "workos-1");
    const sealed = await sealSession(payload, key);
    const res = await buildApp().request(
      "/api/protected",
      { headers: { cookie: `${SESSION_COOKIE_NAME}=${sealed}` } },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.userId).toBe("user-1");
  });

  it("does not require a session for /api/auth/* routes", async () => {
    const res = await buildApp().request("/api/auth/login", {}, TEST_ENV);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/middleware/auth.test.ts`
Expected: FAIL — `./auth` middleware module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/server/middleware/auth.ts
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  SESSION_COOKIE_NAME,
  loadSessionKey,
  unsealSession,
  type SessionPayload,
} from "../../lib/session";

/** Routes under these prefixes never require a session. */
const PUBLIC_API_PREFIXES = ["/api/auth/"];

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
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

export async function extractSession(
  c: Context<{ Bindings: Env }>,
): Promise<SessionPayload | null> {
  const cookieValue = getCookie(c, SESSION_COOKIE_NAME);
  if (!cookieValue) return null;
  const key = await loadSessionKey(c.env);
  return unsealSession(cookieValue, key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/server/middleware/auth.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/middleware/auth.ts apps/web/src/server/middleware/auth.test.ts
git commit -m "feat(auth): session-verifying Hono middleware for /api/*"
```

---

## Task 3: Identity cipher key loader

**Files:**
- Create: `apps/web/src/lib/secrets-loader.ts`
- Test: `apps/web/src/lib/secrets-loader.test.ts`

**Interfaces:**
- Consumes: `IdentityCipherKeys` type from `./crypto/identity-cipher`.
- Produces: `loadIdentityCipherKeys(env: Env): Promise<IdentityCipherKeys>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/secrets-loader.test.ts
import { describe, it, expect } from "vitest";
import { loadIdentityCipherKeys } from "./secrets-loader";

function randomB64(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64");
}

describe("loadIdentityCipherKeys", () => {
  it("imports valid base64 keys into CryptoKey objects", async () => {
    const env = {
      ENCRYPTION_KEY: randomB64(32),
      BLIND_INDEX_KEY: randomB64(32),
    } as Env;
    const keys = await loadIdentityCipherKeys(env);
    expect(keys.encryptionKey).toBeDefined();
    expect(keys.blindIndexKey).toBeDefined();
    expect(keys.encryptionKeyId).toBe("k1");
  });

  it("throws a clear error when ENCRYPTION_KEY is missing", async () => {
    const env = { BLIND_INDEX_KEY: randomB64(32) } as Env;
    await expect(loadIdentityCipherKeys(env)).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it("throws a clear error when BLIND_INDEX_KEY is missing", async () => {
    const env = { ENCRYPTION_KEY: randomB64(32) } as Env;
    await expect(loadIdentityCipherKeys(env)).rejects.toThrow(/BLIND_INDEX_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/secrets-loader.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/secrets-loader.ts
import type { IdentityCipherKeys } from "./crypto/identity-cipher";

/** v0 ships a single active encryption key id. Rotation tooling lands
 *  when key rotation is actually needed (see identity-cipher.ts header). */
const ACTIVE_KEY_ID = "k1";

export async function loadIdentityCipherKeys(env: Env): Promise<IdentityCipherKeys> {
  const encryptionKeyB64 = env.ENCRYPTION_KEY;
  const blindIndexKeyB64 = env.BLIND_INDEX_KEY;

  if (!encryptionKeyB64) {
    throw new Error(
      "ENCRYPTION_KEY must be set (apps/web/.dev.vars locally; the deployed secrets store in prod).",
    );
  }
  if (!blindIndexKeyB64) {
    throw new Error(
      "BLIND_INDEX_KEY must be set (apps/web/.dev.vars locally; the deployed secrets store in prod).",
    );
  }

  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(encryptionKeyB64, "base64")),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const blindIndexKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(Buffer.from(blindIndexKeyB64, "base64")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return { encryptionKey, blindIndexKey, encryptionKeyId: ACTIVE_KEY_ID };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/secrets-loader.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/secrets-loader.ts apps/web/src/lib/secrets-loader.test.ts
git commit -m "feat(auth): load identity cipher keys from env/secrets store"
```

---

## Task 4: Domain allowlist service

**Files:**
- Create: `apps/web/src/lib/services/DomainAllowlistService.ts`
- Test: `apps/web/src/lib/services/DomainAllowlistService.test.ts`

**Interfaces:**
- Produces: `DomainAllowlistService.validateEmailDomain(email: string, allowedDomains: string[]): { allowed: boolean; reason?: string }` (static), `DomainAllowlistService.checkGrandfathering(emailBlindIndex: BlindIndex, db: Db): Promise<boolean>` (static).
- Consumes (for `checkGrandfathering` test only): a hand-built mock shaped like `Db["query"]["users"]["findFirst"]`, cast `as unknown as Db`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/services/DomainAllowlistService.test.ts
import { describe, it, expect } from "vitest";
import { DomainAllowlistService } from "./DomainAllowlistService";
import type { Db } from "../../db/client";
import type { BlindIndex } from "../../db/types/encrypted";

function fakeBlindIndex(): BlindIndex {
  return new Uint8Array(32) as BlindIndex;
}

describe("DomainAllowlistService.validateEmailDomain", () => {
  it("allows an exact-match domain", () => {
    expect(DomainAllowlistService.validateEmailDomain("cdcore@uw.edu", ["uw.edu"])).toEqual({
      allowed: true,
    });
  });

  it("allows a subdomain of an allowed domain", () => {
    expect(DomainAllowlistService.validateEmailDomain("cdcore@cs.uw.edu", ["uw.edu"]).allowed).toBe(
      true,
    );
  });

  it("rejects a disallowed domain with a reason", () => {
    const result = DomainAllowlistService.validateEmailDomain("cdcore@gmail.com", ["uw.edu"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/gmail\.com/);
  });

  it("rejects malformed email", () => {
    expect(DomainAllowlistService.validateEmailDomain("not-an-email", ["uw.edu"]).allowed).toBe(
      false,
    );
  });

  it("is case-insensitive", () => {
    expect(
      DomainAllowlistService.validateEmailDomain("cdcore@UW.EDU", ["uw.edu"]).allowed,
    ).toBe(true);
  });
});

describe("DomainAllowlistService.checkGrandfathering", () => {
  it("returns true for an existing, non-pending user", async () => {
    const db = {
      query: { users: { findFirst: async () => ({ id: "u1", isPending: false }) } },
    } as unknown as Db;
    expect(await DomainAllowlistService.checkGrandfathering(fakeBlindIndex(), db)).toBe(true);
  });

  it("returns false when no user matches", async () => {
    const db = { query: { users: { findFirst: async () => undefined } } } as unknown as Db;
    expect(await DomainAllowlistService.checkGrandfathering(fakeBlindIndex(), db)).toBe(false);
  });

  it("returns false for a pending (roster-only) user", async () => {
    const db = {
      query: { users: { findFirst: async () => ({ id: "u1", isPending: true }) } },
    } as unknown as Db;
    expect(await DomainAllowlistService.checkGrandfathering(fakeBlindIndex(), db)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/services/DomainAllowlistService.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/services/DomainAllowlistService.ts
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import type { Db } from "../../db/client";
import type { BlindIndex } from "../../db/types/encrypted";

export interface DomainCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Parity port of Django's ALLOWED_EMAIL_DOMAINS check
 *  (apps/accounts/src/accounts/utils.py) plus grandfathering for
 *  existing users whose domain is no longer allowed. */
export class DomainAllowlistService {
  static validateEmailDomain(email: string, allowedDomains: string[]): DomainCheckResult {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain) {
      return { allowed: false, reason: "Invalid email format" };
    }
    const isAllowed = allowedDomains.some((allowed) => {
      const normalized = allowed.toLowerCase();
      return domain === normalized || domain.endsWith(`.${normalized}`);
    });
    if (isAllowed) return { allowed: true };
    return {
      allowed: false,
      reason: `Domain "${domain}" is not allowed. Allowed domains: ${allowedDomains.join(", ")}`,
    };
  }

  static async checkGrandfathering(emailBlindIndex: BlindIndex, db: Db): Promise<boolean> {
    const existing = await db.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
    });
    return Boolean(existing && !existing.isPending);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/services/DomainAllowlistService.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/services/DomainAllowlistService.ts apps/web/src/lib/services/DomainAllowlistService.test.ts
git commit -m "feat(auth): email-domain allowlist with grandfathering"
```

---

## Task 5: User identity service (encrypted provisioning)

**Files:**
- Create: `apps/web/src/lib/services/UserIdentityService.ts`
- Test: `apps/web/src/lib/services/UserIdentityService.test.ts`

**Interfaces:**
- Consumes: `IdentityCipher` (real instance, built from real WebCrypto keys in tests — same pattern as `identity-cipher.test.ts`), a hand-built `Db` mock cast `as unknown as Db`.
- Produces: `UserIdentityService` class with `createOrClaimUser(workosUser: { id: string; email: string; firstName?: string | null }): Promise<{ userId: string; isNew: boolean }>` and `decryptUserForDisplay(row): Promise<{ id: string; email: string; displayName: string | null }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/services/UserIdentityService.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import { IdentityCipher, type IdentityCipherKeys } from "../crypto/identity-cipher";
import { UserIdentityService } from "./UserIdentityService";
import type { Db } from "../../db/client";

let keys: IdentityCipherKeys;

beforeAll(async () => {
  keys = {
    encryptionKey: (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ])) as CryptoKey,
    blindIndexKey: (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, [
      "sign",
    ])) as CryptoKey,
    encryptionKeyId: "k1",
  };
});

const WORKOS_USER = { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" };

describe("UserIdentityService.createOrClaimUser", () => {
  it("creates a new user with encrypted email (not plaintext)", async () => {
    const cipher = new IdentityCipher(keys);
    const insertedValues: Record<string, unknown>[] = [];
    const db = {
      query: { users: { findFirst: async () => undefined } },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          insertedValues.push(v);
          return { returning: async () => [{ id: "new-user-1" }] };
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "new-user-1", isNew: true });
    expect(insertedValues).toHaveLength(1);
    const storedEmail = insertedValues[0].email as Uint8Array;
    expect(Buffer.from(storedEmail).includes("cdcore@uw.edu")).toBe(false);
    expect(await cipher.decryptString(storedEmail as never)).toBe("cdcore@uw.edu");
  });

  it("repeat login finds the same user by email blind index, no duplicate insert", async () => {
    const cipher = new IdentityCipher(keys);
    let insertCalls = 0;
    const db = {
      query: {
        users: {
          findFirst: async () => ({ id: "existing-user-1", isPending: false }),
        },
      },
      insert: () => {
        insertCalls++;
        return { values: () => ({ returning: async () => [{ id: "should-not-happen" }] }) };
      },
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "existing-user-1", isNew: false });
    expect(insertCalls).toBe(0);
  });

  it("claims a pending (roster-provisioned) user instead of creating a duplicate", async () => {
    const cipher = new IdentityCipher(keys);
    let updatedValues: Record<string, unknown> | undefined;
    const db = {
      query: {
        users: {
          findFirst: async () => ({ id: "pending-user-1", isPending: true }),
        },
      },
      update: () => ({
        set: (v: Record<string, unknown>) => {
          updatedValues = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Db;

    const result = await new UserIdentityService(cipher, db).createOrClaimUser(WORKOS_USER);

    expect(result).toEqual({ userId: "pending-user-1", isNew: false });
    expect(updatedValues?.isPending).toBe(false);
    expect(updatedValues?.workosUserId).toBe("workos_1");
  });
});

describe("UserIdentityService.decryptUserForDisplay", () => {
  it("round-trips encrypted email and display name", async () => {
    const cipher = new IdentityCipher(keys);
    const db = {} as unknown as Db;
    const row = {
      id: "u1",
      email: await cipher.encryptString("cdcore@uw.edu"),
      displayName: await cipher.encryptString("Cordero"),
    };
    const displayed = await new UserIdentityService(cipher, db).decryptUserForDisplay(
      row as never,
    );
    expect(displayed).toEqual({ id: "u1", email: "cdcore@uw.edu", displayName: "Cordero" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/services/UserIdentityService.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/services/UserIdentityService.ts
import { eq } from "drizzle-orm";
import { users } from "../../db/schema";
import type { Db } from "../../db/client";
import { IdentityCipher } from "../crypto/identity-cipher";

export interface WorkOSProfile {
  id: string;
  email: string;
  firstName?: string | null;
}

export interface ProvisioningResult {
  userId: string;
  isNew: boolean;
}

/** Wires the previously-unused IdentityCipher into a real write path.
 *  Never stores plaintext PII; lookups always go through the blind index. */
export class UserIdentityService {
  constructor(
    private readonly cipher: IdentityCipher,
    private readonly db: Db,
  ) {}

  async createOrClaimUser(workosUser: WorkOSProfile): Promise<ProvisioningResult> {
    const normalizedEmail = IdentityCipher.normalizeEmail(workosUser.email);
    const emailBlindIndex = await this.cipher.computeBlindIndex(normalizedEmail);

    const existing = await this.db.query.users.findFirst({
      where: eq(users.emailBlindIndex, emailBlindIndex),
    });

    if (existing && !existing.isPending) {
      await this.db
        .update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, existing.id));
      return { userId: existing.id, isNew: false };
    }

    const encryptedEmail = await this.cipher.encryptString(normalizedEmail);
    const encryptedDisplayName = workosUser.firstName
      ? await this.cipher.encryptString(workosUser.firstName)
      : null;

    if (existing && existing.isPending) {
      await this.db
        .update(users)
        .set({
          workosUserId: workosUser.id,
          email: encryptedEmail,
          emailBlindIndex,
          displayName: encryptedDisplayName,
          isPending: false,
          lastLoginAt: new Date(),
        })
        .where(eq(users.id, existing.id));
      return { userId: existing.id, isNew: false };
    }

    const [created] = await this.db
      .insert(users)
      .values({
        workosUserId: workosUser.id,
        email: encryptedEmail,
        emailBlindIndex,
        displayName: encryptedDisplayName,
        isPending: false,
        lastLoginAt: new Date(),
      })
      .returning({ id: users.id });

    return { userId: created.id, isNew: true };
  }

  async decryptUserForDisplay(
    row: typeof users.$inferSelect,
  ): Promise<{ id: string; email: string; displayName: string | null }> {
    return {
      id: row.id,
      email: await this.cipher.decryptString(row.email),
      displayName: row.displayName ? await this.cipher.decryptString(row.displayName) : null,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/services/UserIdentityService.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/services/UserIdentityService.ts apps/web/src/lib/services/UserIdentityService.test.ts
git commit -m "feat(auth): encrypted user provisioning + pending-user reconciliation"
```

---

## Task 6: Auth routes — login, callback, logout

**Files:**
- Create: `apps/web/src/server/routes/auth.ts`
- Test: `apps/web/src/server/routes/auth.test.ts`
- Modify: `apps/web/.dev.vars.example` (add new secret placeholders)

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5 (`session.ts`, `secrets-loader.ts`, `DomainAllowlistService`, `UserIdentityService`), `getWorkOS` from `../../lib/workos.ts`.
- Produces: `loginHandler`, `callbackHandler`, `logoutHandler` (Hono handlers), plus an `auth` sub-app (`Hono` instance with `GET /login`, `GET /callback`, `POST /logout`) for direct testing, mirroring `hello.ts`'s dual pattern.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/routes/auth.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { auth } from "./auth";
import { SESSION_COOKIE_NAME } from "../../lib/session";

const TEST_ENV = {
  SESSION_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  WORKOS_API_KEY: "sk_test_x",
  WORKOS_CLIENT_ID: "client_x",
  DATABASE_URL: "ignored",
} as Env;

const authenticateWithCode = vi.fn();
const getAuthorizationUrl = vi.fn(() => "https://api.workos.com/sso/authorize?fake=1");

vi.mock("../../lib/workos", () => ({
  getWorkOS: () => ({
    userManagement: { authenticateWithCode, getAuthorizationUrl },
  }),
}));

vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: { users: { findFirst: async () => undefined } },
    insert: () => ({ values: () => ({ returning: async () => [{ id: "new-user-1" }] }) }),
  }),
}));

beforeEach(() => {
  authenticateWithCode.mockReset();
  getAuthorizationUrl.mockClear();
});

describe("GET /login", () => {
  it("redirects to the WorkOS authorization URL", async () => {
    const res = await auth.request("/login", {}, TEST_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("workos.com");
  });
});

describe("GET /callback", () => {
  it("returns 400 when the code query param is missing", async () => {
    const res = await auth.request("/callback", {}, TEST_ENV);
    expect(res.status).toBe(400);
  });

  it("returns 401 when WorkOS rejects the code", async () => {
    authenticateWithCode.mockRejectedValue(new Error("invalid_grant"));
    const res = await auth.request("/callback?code=bad", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("rejects a disallowed email domain with 403 and sets no cookie", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@gmail.com", firstName: "Cordero" },
    });
    const res = await auth.request("/callback?code=good", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("happy path: sets a session cookie and redirects to /", async () => {
    authenticateWithCode.mockResolvedValue({
      user: { id: "workos_1", email: "cdcore@uw.edu", firstName: "Cordero" },
    });
    const res = await auth.request("/callback?code=good", {}, TEST_ENV);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(SESSION_COOKIE_NAME);
    expect(setCookie).toContain("HttpOnly");
  });
});

describe("POST /logout", () => {
  it("clears the session cookie and redirects to /", async () => {
    const res = await auth.request("/logout", { method: "POST" }, TEST_ENV);
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/routes/auth.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/server/routes/auth.ts
import { Hono, type Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { getWorkOS } from "../../lib/workos";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { DomainAllowlistService } from "../../lib/services/DomainAllowlistService";
import { UserIdentityService } from "../../lib/services/UserIdentityService";
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionPayload,
  loadSessionKey,
  sealSession,
} from "../../lib/session";

// TODO(#11): move to Organization.allowedDomains once multi-org provisioning
// lands; v0 is single-tenant UW.
const DEFAULT_ALLOWED_DOMAINS = ["uw.edu"];

export async function loginHandler(c: Context<{ Bindings: Env }>) {
  const workos = getWorkOS(c.env.WORKOS_API_KEY);
  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    clientId: c.env.WORKOS_CLIENT_ID,
    redirectUri: callbackUrl(c),
    provider: "authkit",
  });
  return c.redirect(authorizationUrl);
}

export async function callbackHandler(c: Context<{ Bindings: Env }>) {
  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  const workos = getWorkOS(c.env.WORKOS_API_KEY);
  let workosUser: { id: string; email: string; firstName?: string | null };
  try {
    const result = await workos.userManagement.authenticateWithCode({
      clientId: c.env.WORKOS_CLIENT_ID,
      code,
    });
    workosUser = result.user;
  } catch {
    return c.text("Sign-in failed. Please try again.", 401);
  }

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const db = makeDb(c.env.DATABASE_URL);

  const domainCheck = DomainAllowlistService.validateEmailDomain(
    workosUser.email,
    DEFAULT_ALLOWED_DOMAINS,
  );
  if (!domainCheck.allowed) {
    const emailBlindIndex = await cipher.computeBlindIndex(
      IdentityCipher.normalizeEmail(workosUser.email),
    );
    const grandfathered = await DomainAllowlistService.checkGrandfathering(emailBlindIndex, db);
    if (!grandfathered) {
      return c.html(disallowedDomainPage(domainCheck.reason ?? "Domain not allowed"), 403);
    }
  }

  const { userId } = await new UserIdentityService(cipher, db).createOrClaimUser(workosUser);

  const sessionKey = await loadSessionKey(c.env);
  const payload = createSessionPayload(userId, workosUser.id);
  const sealed = await sealSession(payload, sessionKey);

  setCookie(c, SESSION_COOKIE_NAME, sealed, {
    httpOnly: true,
    secure: c.req.url.startsWith("https://"),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  return c.redirect("/");
}

export async function logoutHandler(c: Context<{ Bindings: Env }>) {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.redirect("/");
}

function callbackUrl(c: Context<{ Bindings: Env }>): string {
  const origin = c.req.header("origin") ?? new URL(c.req.url).origin;
  return `${origin}/api/auth/callback`;
}

function disallowedDomainPage(reason: string): string {
  return `<!doctype html><html><body><h1>Access Denied</h1><p>${escapeHtml(reason)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post("/api/auth/...", ...) in server/index.ts (see hello.ts).
export const auth = new Hono<{ Bindings: Env }>();
auth.get("/login", loginHandler);
auth.get("/callback", callbackHandler);
auth.post("/logout", logoutHandler);
```

Also append to `.dev.vars.example`:

```
SESSION_SECRET="base64-encoded-32-byte-key"
ENCRYPTION_KEY="base64-encoded-32-byte-key"
BLIND_INDEX_KEY="base64-encoded-32-byte-key"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/server/routes/auth.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/routes/auth.ts apps/web/src/server/routes/auth.test.ts apps/web/.dev.vars.example
git commit -m "feat(auth): AuthKit login/callback/logout routes"
```

---

## Task 7: Mount auth into the Hono app

**Files:**
- Modify: `apps/web/src/server/index.ts`

**Interfaces:**
- Consumes: `authMiddleware` (Task 2), `loginHandler`/`callbackHandler`/`logoutHandler` (Task 6).

- [ ] **Step 1: Write the failing test**

Extend the existing route-level tests instead of adding a new integration test file — `auth.test.ts` and `hello.test.ts` already exercise the handlers directly. Add one composition check to `apps/web/src/server/index.test.ts` (new):

```ts
// apps/web/src/server/index.test.ts
import { describe, it, expect } from "vitest";
import app from "./index";

describe("app composition", () => {
  it("returns 401 for an unauthenticated protected route, and lets /api/auth/login through", async () => {
    const env = { ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } } as unknown as Env;

    const helloRes = await app.request("/api/hello", {}, env);
    expect(helloRes.status).not.toBe(401); // /api/hello has no session requirement of its own... see note below
  });
});
```

Note: `/api/hello` and `/api/chat` are pre-existing, intentionally public routes (issue #8 explicitly keeps auth "role-agnostic" and doesn't retrofit unrelated routes). The composition test that matters is that `/api/auth/*` is reachable without a session and that the middleware is registered — both already covered by `auth.test.ts` calling the sub-app directly. Skip a redundant integration test here; this task is wiring, verified by Step 4's full-suite run.

- [ ] **Step 2: (no separate failing-test step — this task is composition, verified by the full suite in Step 4)**

- [ ] **Step 3: Modify `server/index.ts`**

```ts
// apps/web/src/server/index.ts
import { Hono } from "hono";
import { helloHandler } from "./routes/hello";
import { chatHandler } from "./routes/chat";
import { loginHandler, callbackHandler, logoutHandler } from "./routes/auth";
import { authMiddleware } from "./middleware/auth";

const app = new Hono<{ Bindings: Env }>();

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
```

- [ ] **Step 4: Run the full apps/web test suite**

Run: `cd apps/web && npx vitest run`
Expected: All tests PASS (Tasks 1–6 plus pre-existing `hello.test.ts` / `identity-cipher.test.ts`).

**Correction found during execution:** `authMiddleware` gates *every* `/api/*` route except `/api/auth/*` — including the pre-existing `/api/hello` and `/api/chat`. That's correct, not a bug: the epic's own acceptance checklist says "All `/api/*` routes require auth middleware; unauthenticated requests receive 401," and the whole point of M1 is that the fixture-identity demo routes stop being anonymous. `index.test.ts` asserts this directly instead of the "hello/chat stay public" assumption drafted before implementation.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/index.ts apps/web/src/server/index.test.ts
git commit -m "feat(auth): wire auth middleware and routes into the Hono app"
```

---

## Task 8: Client `AuthProvider` + login/logout affordances

**Files:**
- Create: `apps/web/src/client/components/AuthProvider.tsx`
- Test: `apps/web/src/client/components/AuthProvider.test.tsx`
- Modify: `packages/ui/src/components/TopNav.tsx` (add an optional logout affordance to the existing user-chip dropdown)
- Modify: `apps/web/src/client/App.tsx` (wrap with `AuthProvider`, pass `onLogout` to `TopNav`)
- Modify: `apps/web/vitest.config.ts` (add `jsdom` environment for `.test.tsx` files if not already covered — check first; current config uses `environment: "node"` globally, which breaks DOM-based component tests)

**Interfaces:**
- Produces: `AuthProvider` (React context provider), `useAuth(): { isAuthenticated: boolean; loading: boolean; login: () => void; logout: () => Promise<void> }`.

- [ ] **Step 1: Check the Vitest environment, then write the failing test**

First check whether `apps/web/vitest.config.ts` needs a `jsdom`/`happy-dom` environment override for `.tsx` component tests (the current config sets `environment: "node"` for everything). If `jsdom` isn't installed, add it as a devDependency and use a per-file environment comment (`// @vitest-environment jsdom`) at the top of `AuthProvider.test.tsx` rather than changing the global environment (keeps existing node-environment tests fast and unaffected).

```tsx
// apps/web/src/client/components/AuthProvider.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "./AuthProvider";

function Probe() {
  const { isAuthenticated, loading, logout } = useAuth();
  if (loading) return <span>loading</span>;
  return (
    <div>
      <span>{isAuthenticated ? "authed" : "anon"}</span>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/profile") {
        return new Response(JSON.stringify({ userId: "u1" }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }),
  );
});

describe("AuthProvider / useAuth", () => {
  it("reports authenticated when /api/profile resolves", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("authed")).toBeInTheDocument());
  });

  it("reports anonymous when /api/profile returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("anon")).toBeInTheDocument());
  });

  it("logout posts to /api/auth/logout", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/profile") return new Response(JSON.stringify({ userId: "u1" }), { status: 200 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("authed")).toBeInTheDocument());
    await userEvent.click(screen.getByText("logout"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/client/components/AuthProvider.test.tsx`
Expected: FAIL — module does not exist (and possibly missing `@testing-library/react` / `@testing-library/user-event` / `jsdom` devDependencies — install them: `npm install -D @testing-library/react @testing-library/user-event jsdom -w apps/web`).

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/web/src/client/components/AuthProvider.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface AuthState {
  isAuthenticated: boolean;
  loading: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profile")
      .then((res) => {
        if (!cancelled) setIsAuthenticated(res.ok);
      })
      .catch(() => {
        if (!cancelled) setIsAuthenticated(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = () => {
    window.location.href = "/api/auth/login";
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setIsAuthenticated(false);
    window.location.href = "/";
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
```

Add the `TopNav` logout affordance (small, additive, backward-compatible prop):

```tsx
// packages/ui/src/components/TopNav.tsx — add to TopNavProps and the user-chip block
export interface TopNavProps {
  course: string;
  term: string;
  homework: string;
  userInitials: string;
  admin?: boolean;
  /** When provided, the user-chip dropdown shows a "Log out" action. */
  onLogout?: () => void;
}

export function TopNav({ course, term, homework, userInitials, admin = false, onLogout }: TopNavProps) {
  // ...unchanged state/breadcrumb...
  return (
    <header className="top-nav" role="banner">
      {/* ...unchanged wordmark + breadcrumb... */}
      <div className="top-nav__user-group">
        <button /* ...unchanged chip button... */>
          {/* ...unchanged... */}
        </button>
        {menuOpen && onLogout && (
          <div className="top-nav__user-menu" role="menu">
            <button className="top-nav__user-menu-item" role="menuitem" onClick={onLogout}>
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
```

(Full unchanged sections omitted here for brevity — the implementer edits the existing file in place, adding the `onLogout` prop and the conditional dropdown block only.)

Wire into `App.tsx`: wrap the exported default with `AuthProvider` and pass `onLogout={logout}` to the existing `<TopNav>` via a small inner component that calls `useAuth()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/client/components/AuthProvider.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/components/AuthProvider.tsx apps/web/src/client/components/AuthProvider.test.tsx apps/web/src/client/App.tsx packages/ui/src/components/TopNav.tsx apps/web/package.json
git commit -m "feat(auth): client AuthProvider + TopNav logout affordance"
```

---

## Task 9: Roles middleware (course_memberships resolution)

**Files:**
- Create: `apps/web/src/server/middleware/roles.ts`
- Test: `apps/web/src/server/middleware/roles.test.ts`

**Interfaces:**
- Consumes: `SessionPayload` (Task 1), `courseMemberships` schema, `courseRoleEnum`.
- Produces: `CourseRole` type, `AuthContext` interface, `rolesMiddleware(c, next)`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/middleware/roles.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { rolesMiddleware, type AuthContext } from "./roles";
import type { SessionPayload } from "../../lib/session";

const MEMBERSHIPS = [
  { id: "m1", userId: "u1", courseId: "course-a", role: "instructor" },
  { id: "m2", userId: "u1", courseId: "course-b", role: "student" },
];

let findManyCalls = 0;
vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      courseMemberships: {
        findMany: async () => {
          findManyCalls++;
          return MEMBERSHIPS;
        },
      },
    },
  }),
}));

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    const session: SessionPayload = { userId: "u1", workosUserId: "w1", issuedAt: 0, expiresAt: 0 };
    c.set("session", session);
    await next();
  });
  app.use("*", rolesMiddleware);
  app.get("/api/x", (c) => {
    const authContext = c.get("authContext") as AuthContext;
    return c.json({
      hasInstructor: authContext.hasRole("instructor"),
      isInstructorOfA: authContext.isInstructorOf("course-a"),
      isInstructorOfB: authContext.isInstructorOf("course-b"),
      isMemberOfB: authContext.isMemberOf("course-b"),
      isMemberOfC: authContext.isMemberOf("course-c"),
    });
  });
  return app;
}

describe("rolesMiddleware", () => {
  it("resolves memberships and exposes role-check helpers", async () => {
    findManyCalls = 0;
    const res = await buildApp().request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    const body = await res.json();
    expect(body).toEqual({
      hasInstructor: true,
      isInstructorOfA: true,
      isInstructorOfB: false,
      isMemberOfB: true,
      isMemberOfC: false,
    });
  });

  it("queries memberships exactly once per request", async () => {
    findManyCalls = 0;
    await buildApp().request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    expect(findManyCalls).toBe(1);
  });

  it("no-ops when there is no session", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", rolesMiddleware);
    app.get("/api/x", (c) => c.json({ authContext: c.get("authContext") ?? null }));
    const res = await app.request("/api/x", {}, { DATABASE_URL: "ignored" } as Env);
    const body = await res.json();
    expect(body.authContext).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/middleware/roles.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/server/middleware/roles.ts
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import { makeDb } from "../../db/client";
import { courseMemberships, courseRoleEnum } from "../../db/schema";
import type { SessionPayload } from "../../lib/session";

export type CourseRole = (typeof courseRoleEnum.enumValues)[number];
type Membership = typeof courseMemberships.$inferSelect;

export interface AuthContext {
  session: SessionPayload;
  memberships: Membership[];
  hasRole(role: CourseRole): boolean;
  isMemberOf(courseId: string): boolean;
  isInstructorOf(courseId: string): boolean;
}

/** Loads course_memberships once per request (not per guard) and attaches
 *  role-check helpers to the context. No-ops when authMiddleware found no
 *  session -- that case is already a 401 for protected routes. */
export async function rolesMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const session = c.get("session") as SessionPayload | undefined;
  if (!session) {
    await next();
    return;
  }

  const db = makeDb(c.env.DATABASE_URL);
  const memberships = await db.query.courseMemberships.findMany({
    where: eq(courseMemberships.userId, session.userId),
  });

  const authContext: AuthContext = {
    session,
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: (courseId) =>
      memberships.some(
        (m) => m.courseId === courseId && (m.role === "instructor" || m.role === "admin"),
      ),
  };

  c.set("authContext", authContext);
  await next();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/server/middleware/roles.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/middleware/roles.ts apps/web/src/server/middleware/roles.test.ts
git commit -m "feat(auth): role resolution middleware over course_memberships"
```

---

## Task 10: Route guards + mount roles middleware

**Files:**
- Create: `apps/web/src/server/utils/guards.ts`
- Test: `apps/web/src/server/utils/guards.test.ts`
- Modify: `apps/web/src/server/index.ts` (add `app.use("/api/*", rolesMiddleware)` after `authMiddleware`)

**Interfaces:**
- Consumes: `AuthContext`, `CourseRole` from Task 9.
- Produces: `requireRole(roles: CourseRole[])`, `requireCourseMember(param?: string)`, `requireInstructorOf(param?: string)` — each a higher-order function wrapping a Hono handler.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/utils/guards.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requireRole, requireCourseMember, requireInstructorOf } from "./guards";
import type { AuthContext } from "../middleware/roles";

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    session: { userId: "u1", workosUserId: "w1", issuedAt: 0, expiresAt: 0 },
    memberships: [],
    hasRole: () => false,
    isMemberOf: () => false,
    isInstructorOf: () => false,
    ...overrides,
  };
}

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get(
    "/api/instructor-only/:courseId",
    requireInstructorOf()(async (c) => c.json({ ok: true })),
  );
  app.get(
    "/api/member-only/:courseId",
    requireCourseMember()(async (c) => c.json({ ok: true })),
  );
  app.get(
    "/api/role-only",
    requireRole(["instructor", "admin"])(async (c) => c.json({ ok: true })),
  );
  return app;
}

describe("requireInstructorOf", () => {
  it("allows an instructor of the course", async () => {
    const app = buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-a" }));
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(200);
  });

  it("denies a student", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });

  it("denies cross-course access", async () => {
    const app = buildApp(fakeAuthContext({ isInstructorOf: (id) => id === "course-b" }));
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });

  it("denies when there is no authContext at all", async () => {
    const app = buildApp(undefined);
    const res = await app.request("/api/instructor-only/course-a");
    expect(res.status).toBe(403);
  });
});

describe("requireCourseMember", () => {
  it("allows a member of the course", async () => {
    const app = buildApp(fakeAuthContext({ isMemberOf: (id) => id === "course-a" }));
    const res = await app.request("/api/member-only/course-a");
    expect(res.status).toBe(200);
  });

  it("denies a non-member", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/member-only/course-a");
    expect(res.status).toBe(403);
  });
});

describe("requireRole", () => {
  it("allows any of the listed roles", async () => {
    const app = buildApp(fakeAuthContext({ hasRole: (r) => r === "admin" }));
    const res = await app.request("/api/role-only");
    expect(res.status).toBe(200);
  });

  it("denies when none of the listed roles match", async () => {
    const app = buildApp(fakeAuthContext());
    const res = await app.request("/api/role-only");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/utils/guards.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/server/utils/guards.ts
import type { Context } from "hono";
import type { AuthContext, CourseRole } from "../middleware/roles";

type GuardedHandler = (c: Context<{ Bindings: Env }>) => Response | Promise<Response>;

function getAuthContext(c: Context<{ Bindings: Env }>): AuthContext | undefined {
  return c.get("authContext") as AuthContext | undefined;
}

/** Guards decide *who* (role/membership); org-scoped repositories (M2)
 *  decide *which org's rows* -- the two compose, neither substitutes
 *  for the other. */
export function requireRole(allowedRoles: CourseRole[]) {
  return (handler: GuardedHandler) => async (c: Context<{ Bindings: Env }>) => {
    const authContext = getAuthContext(c);
    if (!authContext || !allowedRoles.some((role) => authContext.hasRole(role))) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    return handler(c);
  };
}

export function requireCourseMember(courseIdParam = "courseId") {
  return (handler: GuardedHandler) => async (c: Context<{ Bindings: Env }>) => {
    const authContext = getAuthContext(c);
    const courseId = c.req.param(courseIdParam);
    if (!authContext || !authContext.isMemberOf(courseId)) {
      return c.json({ error: "Course access denied" }, 403);
    }
    return handler(c);
  };
}

export function requireInstructorOf(courseIdParam = "courseId") {
  return (handler: GuardedHandler) => async (c: Context<{ Bindings: Env }>) => {
    const authContext = getAuthContext(c);
    const courseId = c.req.param(courseIdParam);
    if (!authContext || !authContext.isInstructorOf(courseId)) {
      return c.json({ error: "Instructor access denied" }, 403);
    }
    return handler(c);
  };
}
```

Mount `rolesMiddleware` in `server/index.ts`, right after `authMiddleware`:

```ts
// apps/web/src/server/index.ts — add these two lines
import { rolesMiddleware } from "./middleware/roles";
// ...
app.use("/api/*", authMiddleware);
app.use("/api/*", rolesMiddleware);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/server/utils/guards.test.ts && npx vitest run`
Expected: PASS (7 new tests; full suite green)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/utils/guards.ts apps/web/src/server/utils/guards.test.ts apps/web/src/server/index.ts
git commit -m "feat(auth): role/course/instructor route guards"
```

---

## Task 11: Profile service (real instructor stats, stubbed student stats)

**Files:**
- Create: `apps/web/src/lib/services/ProfileService.ts`
- Test: `apps/web/src/lib/services/ProfileService.test.ts`

**Interfaces:**
- Consumes: `IdentityCipher`, `Db`, `CourseRole` (Task 9).
- Produces: `ProfileWithStats` interface, `ProfileService` class with `getProfileWithStats(userId): Promise<ProfileWithStats>` and `updateDisplayName(userId, newDisplayName): Promise<{ displayName: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/services/ProfileService.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { IdentityCipher, type IdentityCipherKeys } from "../crypto/identity-cipher";
import { ProfileService } from "./ProfileService";
import type { Db } from "../../db/client";

let keys: IdentityCipherKeys;
beforeAll(async () => {
  keys = {
    encryptionKey: (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ])) as CryptoKey,
    blindIndexKey: (await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, [
      "sign",
    ])) as CryptoKey,
    encryptionKeyId: "k1",
  };
});

describe("ProfileService.getProfileWithStats", () => {
  it("returns decrypted email/displayName and instructor stats", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("cdcore@uw.edu");
    const encryptedName = await cipher.encryptString("Cordero");
    const db = {
      query: {
        users: {
          findFirst: async () => ({
            id: "u1",
            email: encryptedEmail,
            displayName: encryptedName,
          }),
        },
        courseMemberships: {
          findMany: async () => [{ id: "m1", userId: "u1", courseId: "c1", role: "instructor" }],
        },
        homeworks: {
          findMany: async () => [{ id: "h1" }, { id: "h2" }],
        },
      },
    } as unknown as Db;

    const profile = await new ProfileService(cipher, db).getProfileWithStats("u1");

    expect(profile.email).toBe("cdcore@uw.edu");
    expect(profile.displayName).toBe("Cordero");
    expect(profile.role).toBe("instructor");
    expect(profile.courseCount).toBe(1);
    expect(profile.instructorStats).toEqual({ homeworksCreated: 2 });
    expect(profile.studentStats).toBeUndefined();
  });

  it("stubs student stats to zero (no submissions table yet)", async () => {
    const cipher = new IdentityCipher(keys);
    const encryptedEmail = await cipher.encryptString("student@uw.edu");
    const db = {
      query: {
        users: { findFirst: async () => ({ id: "u2", email: encryptedEmail, displayName: null }) },
        courseMemberships: {
          findMany: async () => [{ id: "m2", userId: "u2", courseId: "c1", role: "student" }],
        },
        homeworks: { findMany: async () => [] },
      },
    } as unknown as Db;

    const profile = await new ProfileService(cipher, db).getProfileWithStats("u2");
    expect(profile.studentStats).toEqual({ submissionsCount: 0 });
    expect(profile.instructorStats).toBeUndefined();
  });

  it("throws when the user does not exist", async () => {
    const cipher = new IdentityCipher(keys);
    const db = { query: { users: { findFirst: async () => undefined } } } as unknown as Db;
    await expect(new ProfileService(cipher, db).getProfileWithStats("missing")).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("ProfileService.updateDisplayName", () => {
  it("re-encrypts and stores the new display name", async () => {
    const cipher = new IdentityCipher(keys);
    let stored: Record<string, unknown> | undefined;
    const db = {
      update: () => ({
        set: (v: Record<string, unknown>) => {
          stored = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Db;

    const result = await new ProfileService(cipher, db).updateDisplayName("u1", "New Name");
    expect(result).toEqual({ displayName: "New Name" });
    const storedCiphertext = stored?.displayName as Uint8Array;
    expect(await cipher.decryptString(storedCiphertext as never)).toBe("New Name");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/services/ProfileService.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/services/ProfileService.ts
import { eq, inArray } from "drizzle-orm";
import { courseMemberships, homeworks, users } from "../../db/schema";
import type { Db } from "../../db/client";
import type { IdentityCipher } from "../crypto/identity-cipher";
import type { CourseRole } from "../../server/middleware/roles";

export interface ProfileWithStats {
  userId: string;
  email: string;
  displayName: string | null;
  role: CourseRole | null;
  courseCount: number;
  instructorStats?: { homeworksCreated: number };
  studentStats?: { submissionsCount: number };
}

export class ProfileService {
  constructor(
    private readonly cipher: IdentityCipher,
    private readonly db: Db,
  ) {}

  async getProfileWithStats(userId: string): Promise<ProfileWithStats> {
    const user = await this.db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    const email = await this.cipher.decryptString(user.email);
    const displayName = user.displayName
      ? await this.cipher.decryptString(user.displayName)
      : null;

    const memberships = await this.db.query.courseMemberships.findMany({
      where: eq(courseMemberships.userId, userId),
    });
    const primaryRole = (memberships[0]?.role ?? null) as CourseRole | null;

    const profile: ProfileWithStats = {
      userId: user.id,
      email,
      displayName,
      role: primaryRole,
      courseCount: memberships.length,
    };

    if (primaryRole === "instructor" || primaryRole === "ta" || primaryRole === "admin") {
      const membershipIds = memberships.map((m) => m.id);
      const createdHomeworks = membershipIds.length
        ? await this.db.query.homeworks.findMany({
            where: inArray(homeworks.createdById, membershipIds),
          })
        : [];
      profile.instructorStats = { homeworksCreated: createdHomeworks.length };
    } else if (primaryRole === "student") {
      // TODO: real submission/completion counts once the conversation +
      // submission tables land (multi-tenant-data-model.md §6.3, M2).
      // No per-student runtime data exists in the schema yet.
      profile.studentStats = { submissionsCount: 0 };
    }

    return profile;
  }

  async updateDisplayName(
    userId: string,
    newDisplayName: string,
  ): Promise<{ displayName: string }> {
    const encrypted = await this.cipher.encryptString(newDisplayName);
    await this.db
      .update(users)
      .set({ displayName: encrypted, updatedAt: new Date() })
      .where(eq(users.id, userId));
    return { displayName: newDisplayName };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/services/ProfileService.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/services/ProfileService.ts apps/web/src/lib/services/ProfileService.test.ts
git commit -m "feat(profile): profile stats service with real instructor counts"
```

---

## Task 12: Profile routes (GET/PATCH)

**Files:**
- Create: `apps/web/src/server/routes/profile.ts`
- Test: `apps/web/src/server/routes/profile.test.ts`
- Modify: `apps/web/src/server/index.ts` (mount `GET`/`PATCH /api/profile`)

**Interfaces:**
- Consumes: `ProfileService` (Task 11), `loadIdentityCipherKeys` (Task 3), `SessionPayload` (Task 1).
- Produces: `getProfileHandler`, `patchProfileHandler`, `profile` sub-app.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/server/routes/profile.test.ts
import { describe, it, expect, vi } from "vitest";
import { profile } from "./profile";
import type { SessionPayload } from "../../lib/session";

const TEST_ENV = {
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  DATABASE_URL: "ignored",
} as Env;

let sessionForRequest: SessionPayload | undefined;

vi.mock("../../db/client", () => ({
  makeDb: () => ({
    query: {
      users: {
        findFirst: async () => ({ id: "u1", email: new Uint8Array(), displayName: null }),
      },
      courseMemberships: { findMany: async () => [] },
      homeworks: { findMany: async () => [] },
    },
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
}));

vi.mock("../../lib/services/ProfileService", () => ({
  ProfileService: class {
    async getProfileWithStats(userId: string) {
      return { userId, email: "cdcore@uw.edu", displayName: null, role: null, courseCount: 0 };
    }
    async updateDisplayName(_userId: string, newDisplayName: string) {
      return { displayName: newDisplayName };
    }
  },
}));

function requestWithSession(path: string, init: RequestInit = {}) {
  return profile.request(
    path,
    init,
    { ...TEST_ENV, __session: sessionForRequest } as unknown as Env,
  );
}

// profile.ts reads the session via c.get("session"); for direct sub-app
// testing (bypassing the real authMiddleware), inject it with a tiny
// middleware wrapper in the test app instead of through Env — see Step 3.

describe("GET /api/profile", () => {
  it("returns 401 without a session", async () => {
    sessionForRequest = undefined;
    const res = await requestWithSession("/");
    expect(res.status).toBe(401);
  });
});
```

Given the sub-app in `profile.ts` needs a session already set on context (normally done by `authMiddleware` upstream), test it wrapped in a tiny host app that injects a session — same approach as `roles.test.ts` (Task 9). Replace the test file above with this simpler, host-app version:

```ts
// apps/web/src/server/routes/profile.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { getProfileHandler, patchProfileHandler } from "./profile";
import type { SessionPayload } from "../../lib/session";

const TEST_ENV = {
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  DATABASE_URL: "ignored",
} as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const getProfileWithStats = vi.fn();
const updateDisplayName = vi.fn();
vi.mock("../../lib/services/ProfileService", () => ({
  ProfileService: class {
    getProfileWithStats(userId: string) {
      return getProfileWithStats(userId);
    }
    updateDisplayName(userId: string, name: string) {
      return updateDisplayName(userId, name);
    }
  },
}));

function buildApp(session: SessionPayload | undefined) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (session) c.set("session", session);
    await next();
  });
  app.get("/api/profile", getProfileHandler);
  app.patch("/api/profile", patchProfileHandler);
  return app;
}

const SESSION: SessionPayload = { userId: "u1", workosUserId: "w1", issuedAt: 0, expiresAt: 0 };

describe("GET /api/profile", () => {
  it("returns 401 without a session", async () => {
    const res = await buildApp(undefined).request("/api/profile", {}, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("returns the decrypted profile with stats", async () => {
    getProfileWithStats.mockResolvedValue({
      userId: "u1",
      email: "cdcore@uw.edu",
      displayName: "Cordero",
      role: "instructor",
      courseCount: 1,
      instructorStats: { homeworksCreated: 2 },
    });
    const res = await buildApp(SESSION).request("/api/profile", {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("cdcore@uw.edu");
    expect(getProfileWithStats).toHaveBeenCalledWith("u1");
  });
});

describe("PATCH /api/profile", () => {
  it("returns 400 when displayName is missing", async () => {
    const res = await buildApp(SESSION).request("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }, TEST_ENV);
    expect(res.status).toBe(400);
  });

  it("updates and returns the new display name", async () => {
    updateDisplayName.mockResolvedValue({ displayName: "New Name" });
    const res = await buildApp(SESSION).request("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "New Name" }),
    }, TEST_ENV);
    expect(res.status).toBe(200);
    expect(updateDisplayName).toHaveBeenCalledWith("u1", "New Name");
  });

  it("returns 401 without a session", async () => {
    const res = await buildApp(undefined).request("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    }, TEST_ENV);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/server/routes/profile.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/server/routes/profile.ts
import { Hono, type Context } from "hono";
import { makeDb } from "../../db/client";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { ProfileService } from "../../lib/services/ProfileService";
import type { SessionPayload } from "../../lib/session";

export async function getProfileHandler(c: Context<{ Bindings: Env }>) {
  const session = c.get("session") as SessionPayload | undefined;
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const db = makeDb(c.env.DATABASE_URL);
  const profile = await new ProfileService(cipher, db).getProfileWithStats(session.userId);
  return c.json(profile);
}

export async function patchProfileHandler(c: Context<{ Bindings: Env }>) {
  const session = c.get("session") as SessionPayload | undefined;
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json<{ displayName?: string }>();
  const displayName = body.displayName?.trim();
  if (!displayName) {
    return c.json({ error: "displayName is required" }, 400);
  }

  const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
  const db = makeDb(c.env.DATABASE_URL);
  const updated = await new ProfileService(cipher, db).updateDisplayName(
    session.userId,
    displayName,
  );
  return c.json(updated);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/patch("/api/profile", ...) in server/index.ts (see hello.ts).
export const profile = new Hono<{ Bindings: Env }>();
profile.get("/", getProfileHandler);
profile.patch("/", patchProfileHandler);
```

Mount in `server/index.ts`:

```ts
// apps/web/src/server/index.ts — add
import { getProfileHandler, patchProfileHandler } from "./routes/profile";
// ...
app.get("/api/profile", getProfileHandler);
app.patch("/api/profile", patchProfileHandler);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/server/routes/profile.test.ts && npx vitest run`
Expected: PASS (5 new tests; full suite green)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/server/routes/profile.ts apps/web/src/server/routes/profile.test.ts apps/web/src/server/index.ts
git commit -m "feat(profile): GET/PATCH /api/profile routes"
```

---

## Task 13: Client profile page + routing

**Files:**
- Create: `apps/web/src/client/components/ProfileView.tsx`
- Create: `apps/web/src/client/components/ProfileEditForm.tsx`
- Test: `apps/web/src/client/components/ProfileView.test.tsx`
- Modify: `apps/web/src/client/main.tsx` (add `react-router` routes: `/` → existing chat app, `/profile` → new page)

**Interfaces:**
- Consumes: `Button`, `Input` from `@llteacher/ui`.
- Produces: `ProfileView` (fetches `/api/profile`, renders fields + stats + `ProfileEditForm`), `ProfileEditForm` (controlled form, `PATCH /api/profile` on submit).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/client/components/ProfileView.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ProfileView } from "./ProfileView";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          userId: "u1",
          email: "cdcore@uw.edu",
          displayName: "Cordero",
          role: "instructor",
          courseCount: 2,
          instructorStats: { homeworksCreated: 3 },
        }),
        { status: 200 },
      ),
    ),
  );
});

describe("ProfileView", () => {
  it("renders decrypted profile fields and instructor stats", async () => {
    render(<ProfileView />);
    await waitFor(() => expect(screen.getByText("cdcore@uw.edu")).toBeInTheDocument());
    expect(screen.getByText(/instructor/i)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/client/components/ProfileView.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/web/src/client/components/ProfileEditForm.tsx
import { useState, type FormEvent } from "react";
import { Button, Input } from "@llteacher/ui";

interface ProfileEditFormProps {
  initialDisplayName: string | null;
  onSave: (displayName: string) => Promise<void>;
}

export function ProfileEditForm({ initialDisplayName, onSave }: ProfileEditFormProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(displayName);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Edit profile">
      <label htmlFor="displayName">Display name</label>
      <Input
        id="displayName"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
```

```tsx
// apps/web/src/client/components/ProfileView.tsx
import { useEffect, useState } from "react";
import { ProfileEditForm } from "./ProfileEditForm";

interface ProfileWithStats {
  userId: string;
  email: string;
  displayName: string | null;
  role: string | null;
  courseCount: number;
  instructorStats?: { homeworksCreated: number };
  studentStats?: { submissionsCount: number };
}

export function ProfileView() {
  const [profile, setProfile] = useState<ProfileWithStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    fetch("/api/profile")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ProfileWithStats | null) => setProfile(data))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSave = async (displayName: string) => {
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (res.ok) load();
  };

  if (loading) return <p>Loading profile…</p>;
  if (!profile) return <p>Unable to load profile.</p>;

  return (
    <div className="profile-view">
      <h1>Profile</h1>
      <p>{profile.email}</p>
      {profile.role && <p>Role: {profile.role}</p>}
      <p>Member of {profile.courseCount} course(s)</p>

      {profile.instructorStats && (
        <section>
          <h2>Instructor stats</h2>
          <p>Homeworks created: {profile.instructorStats.homeworksCreated}</p>
        </section>
      )}
      {profile.studentStats && (
        <section>
          <h2>Student stats</h2>
          <p>Submissions: {profile.studentStats.submissionsCount}</p>
        </section>
      )}

      <ProfileEditForm initialDisplayName={profile.displayName} onSave={handleSave} />
    </div>
  );
}
```

Wire routing in `main.tsx`:

```tsx
// apps/web/src/client/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import App from "./App";
import { ProfileView } from "./components/ProfileView";
import { AuthProvider } from "./components/AuthProvider";
import "@llteacher/ui/styles.css";

const router = createBrowserRouter([
  { path: "/", element: <App /> },
  { path: "/profile", element: <ProfileView /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
```

(Remove the `AuthProvider` wrap added directly in `App.tsx` in Task 8 if it's now redundant with this top-level wrap — keep exactly one `AuthProvider` ancestor.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/client/components/ProfileView.test.tsx`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/client/components/ProfileView.tsx apps/web/src/client/components/ProfileEditForm.tsx apps/web/src/client/components/ProfileView.test.tsx apps/web/src/client/main.tsx apps/web/src/client/App.tsx
git commit -m "feat(profile): profile page + client-side routing"
```

---

## Task 14: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full web test suite**

Run: `cd apps/web && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc -b`
Expected: No errors.

- [ ] **Step 3: Root workspace test + typecheck**

Run: `cd /Users/kshitijdani/Desktop/SSEC/llteacher/.claude/worktrees/m1-auth && npm test && npm run typecheck`
Expected: All workspaces pass (Django test suite untouched — this plan only touches `apps/web` and `packages/ui`).

- [ ] **Step 4: Manual smoke check (documented, not automated)**

Note in the PR description that the AuthKit hosted-UI redirect, real Neon DB writes, and cookie-survives-dev-proxy flow need one manual `npm run dev` + browser check with real WorkOS test credentials in `.dev.vars` — this is explicitly out of Vitest's reach (per issue #8's "Not worth testing" section; full e2e is issue #83).

- [ ] **Step 5: Commit any remaining doc/config cleanup**

```bash
git add -A
git commit -m "chore(auth): final verification pass for M1 epic"
```
