/* --------------------------------------------------------------------------
   #73: instructor-managed Canvas API token.

   Same authorization shape as llm-configs' own routes, and the same
   TRACKED GAP those routes document (see llmConfigs.ts's own header):
   gated on instructor-of-COURSE, operating on that course's ORGANIZATION
   credential -- an instructor of one course can set/replace/delete the
   Canvas token every course in the same org's Canvas sync depends on.
   Narrowing this needs the same Org Admin role #367 already tracks for
   llm-configs; not solved here for the same reason it wasn't solved there.

   Every response from this file is checked, in its own tests, to never
   carry the plaintext token -- only a masked summary.
   -------------------------------------------------------------------------- */

import { type Context } from "hono";
import { Effect } from "effect";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { CanvasRateLimitedError, validateCanvasToken } from "../../lib/canvas-api";
import {
  deleteCanvasCredential,
  getCanvasCredentialSummary,
  getDecryptedCanvasCredential,
  setCanvasCredential,
} from "../repositories/organizationCredentials";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES, auditBestEffort } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { OrgScope } from "../repositories/scope";
import type { CanvasCredentialBody } from "../../shared/types";
import { BadRequest, DatabaseError, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { external, query, type Database } from "../effect/services";

const TOKEN_MAX = 4_000;
const BASE_URL_MAX = 500;

type InstructorOrgCtx = { scope: OrgScope; courseId: string; authContext: AuthContext };

function orgScopeForInstructor(
  c: Context<AppEnv>,
): Effect.Effect<InstructorOrgCtx, Forbidden | DatabaseError, Database> {
  return Effect.gen(function* () {
    const denied = () => new Forbidden({ message: "Instructor access denied" });
    const courseId = c.req.param("courseId");
    const authContext = c.get("authContext") as AuthContext | undefined;
    if (!authContext || !courseId || !authContext.isInstructorOf(courseId)) return yield* denied();
    const scope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, courseId));
    if (!scope) return yield* denied();
    return { scope, courseId, authContext };
  });
}

/** The identity cipher the stored token is encrypted under. Missing or
 *  malformed ENCRYPTION_KEY/BLIND_INDEX_KEY is a deployment fault, not a
 *  request outcome: it is a defect, logged and answered with the generic
 *  503 (as app.onError answered the throw before). A token that fails to
 *  decrypt under a valid key surfaces from inside the repository call as a
 *  DatabaseError -- also 503, never a "no token on file" 404. */
const loadCipher = (env: Env) =>
  Effect.promise(async () => new IdentityCipher(await loadIdentityCipherKeys(env)));

const NO_TOKEN_MESSAGE = "No Canvas token is on file for this organization.";

/** Rejects anything that isn't an https URL with no path -- the base URL
 *  is used to build every subsequent Canvas API request
 *  (`${baseUrl}/api/v1/...`), so a typo here (a trailing slash, a stray
 *  path segment, a plain-http URL) fails every later call with a
 *  confusing 404 instead of this one, immediate, actionable message. */
function parseCanvasBaseUrl(raw: unknown): { baseUrl: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "Enter your Canvas instance URL (e.g. https://canvas.uw.edu)." };
  }
  const trimmed = raw.trim();
  if (trimmed.length > BASE_URL_MAX) return { error: "That URL is too long." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "Enter a valid URL (e.g. https://canvas.uw.edu)." };
  }
  if (url.protocol !== "https:") {
    return { error: "Canvas instance URLs must use https." };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return { error: "Enter the Canvas instance's base URL only, with no path (e.g. https://canvas.uw.edu)." };
  }
  if (isDisallowedCanvasHost(url.hostname)) {
    return {
      error: "That doesn't look like a Canvas instance URL. Enter your institution's public Canvas domain (e.g. https://canvas.uw.edu).",
    };
  }
  return { baseUrl: `${url.protocol}//${url.host}` };
}

/** #2 (security review, PR #457): this base URL becomes the target of
 *  every subsequent Canvas request this app makes (canvas-api.ts), with
 *  the org's bearer token attached, and `validateCanvasToken`/
 *  `listCanvasCourses` reflect response fields back to the caller --
 *  unvalidated, this is SSRF plus an internal host/port scanner (status
 *  and latency differentiate reachability). This app has no DNS-
 *  resolution capability in this environment (Cloudflare Workers) to
 *  check where a hostname actually resolves, and even a resolved check is
 *  defeatable by DNS rebinding between validation and use -- so this is a
 *  best-effort, defense-in-depth filter on the URL's literal host.
 *  `fetchAllPages`' own same-origin pagination lock (canvas-api.ts) is
 *  the load-bearing mitigation for the actual request boundary this URL
 *  feeds. A real Canvas instance is always a public DNS hostname with at
 *  least one dot -- "localhost", a bare IP literal, or a single-label
 *  host is never legitimate here, on any institution's Canvas. */
function isDisallowedCanvasHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.includes(":")) return true; // IPv6 literal (URL.hostname keeps the brackets)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal (URL parsing already
  // canonicalizes hex/octal-obfuscated forms into this shape, so this one
  // check covers those too)
  if (!host.includes(".")) return true; // no TLD -- not a real public hostname
  return false;
}

function parseExpiresAt(raw: unknown): { expiresAt: Date | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { expiresAt: null };
  if (typeof raw !== "string") return { error: "expiresAt must be an ISO date string." };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { error: "That expiry date could not be read." };
  return { expiresAt: parsed };
}

export const getCanvasCredentialHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);

  const cipher = yield* loadCipher(c.env);
  const credential = yield* query(
    "getCanvasCredentialSummary",
    (db) => getCanvasCredentialSummary(db, cipher, ctx.scope),
  );
  return c.json({ credential });
}));

export const setCanvasCredentialHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);

  const body = yield* Effect.tryPromise({
    try: () => c.req.json<CanvasCredentialBody>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return yield* new BadRequest({ message: "Paste your Canvas API token." });
  if (token.length > TOKEN_MAX) {
    return yield* new BadRequest({ message: "That token is longer than expected. Check what you pasted." });
  }

  const baseUrlResult = parseCanvasBaseUrl(body.canvasBaseUrl);
  if ("error" in baseUrlResult) return yield* new BadRequest({ message: baseUrlResult.error });
  const expiresAtResult = parseExpiresAt(body.expiresAt);
  if ("error" in expiresAtResult) return yield* new BadRequest({ message: expiresAtResult.error });

  const cipher = yield* loadCipher(c.env);
  // Read-before-write, purely to pick the right audit action (#73: "set" vs
  // "replace" are distinguishable log entries) -- setCanvasCredential's own
  // upsert is what actually decides create-vs-update at the database level.
  const existed =
    (yield* query("getCanvasCredentialSummary", (db) => getCanvasCredentialSummary(db, cipher, ctx.scope))) !==
    null;
  yield* query("setCanvasCredential", (db) =>
    setCanvasCredential(db, cipher, ctx.scope, {
      token,
      canvasBaseUrl: baseUrlResult.baseUrl,
      expiresAt: expiresAtResult.expiresAt,
    }),
  );

  yield* auditCredentialChange(
    ctx,
    existed ? AUDIT_ACTIONS.CANVAS_TOKEN_REPLACED : AUDIT_ACTIONS.CANVAS_TOKEN_SET,
    { canvasBaseUrl: baseUrlResult.baseUrl },
  );

  const credential = yield* query(
    "getCanvasCredentialSummary",
    (db) => getCanvasCredentialSummary(db, cipher, ctx.scope),
  );
  return c.json({ credential });
}));

export const deleteCanvasCredentialHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);

  const result = yield* query("deleteCanvasCredential", (db) => deleteCanvasCredential(db, ctx.scope));
  if (!result.deleted) return yield* new NotFound({ message: NO_TOKEN_MESSAGE });

  yield* auditCredentialChange(ctx, AUDIT_ACTIONS.CANVAS_TOKEN_DELETED, {});
  return c.json({ credential: null });
}));

/** #73's "Validate" button: the cheapest real Canvas call this token can
 *  make. Reports ok:false (200) rather than an error status for an
 *  ordinary "this token doesn't work" outcome -- same reasoning as
 *  testLlmConfigHandler's own 200/ok:false shape: the *request* succeeded
 *  and produced a result the instructor needs to read. That includes
 *  Canvas itself being unreachable or rate-limiting: those are results
 *  about the instance URL/token the instructor is checking, so they are
 *  answered 200 ok:false too, never the generic 503. */
export const validateCanvasCredentialHandler = effectHandler((c) => Effect.gen(function* () {
  const ctx = yield* orgScopeForInstructor(c);

  const cipher = yield* loadCipher(c.env);
  const decrypted = yield* query(
    "getDecryptedCanvasCredential",
    (db) => getDecryptedCanvasCredential(db, cipher, ctx.scope),
  );
  if (!decrypted) return yield* new NotFound({ message: NO_TOKEN_MESSAGE });

  const outcome = yield* external(
    "canvas",
    "validateCanvasToken",
    () => validateCanvasToken(decrypted.canvasBaseUrl, decrypted.token),
    [CanvasRateLimitedError],
  ).pipe(
    Effect.map((result) => ({ result })),
    Effect.catchTags({
      // #11 (compatibility review, PR #457): distinct from the generic
      // unreachable-instance message below -- a rate limit means the token
      // and instance are both fine, just to try again shortly.
      CanvasRateLimitedError: (err) => {
        logServerError("validateCanvasCredentialHandler", err);
        return Effect.succeed({
          response: c.json({ ok: false, message: "Canvas is rate-limiting this request. Wait a moment and try again." }, 200),
        });
      },
      ExternalServiceError: (err) => {
        logServerError("validateCanvasCredentialHandler", err.cause);
        return Effect.succeed({
          response: c.json(
            { ok: false, message: "Could not reach Canvas. Check the instance URL and try again." },
            200,
          ),
        });
      },
    }),
  );
  if ("response" in outcome) return outcome.response;
  const { result } = outcome;

  yield* auditCredentialChange(ctx, AUDIT_ACTIONS.CANVAS_TOKEN_VALIDATED, { ok: result.ok });

  if (!result.ok) return c.json({ ok: false, message: result.message });
  return c.json({ ok: true, canvasUserId: result.canvasUserId, name: result.name });
}));

/** Best-effort (#147), scoped to the course's org. Never includes the
 *  token itself -- callers pass only non-secret metadata. A DatabaseError
 *  here is logged and swallowed: an audit outage must not fail a change
 *  that already landed. */
function auditCredentialChange(
  ctx: InstructorOrgCtx,
  action: string,
  metadata: Record<string, unknown>,
): Effect.Effect<void, never, Database> {
  return query("auditBestEffort", (db) =>
    auditBestEffort(db, [ctx.scope], {
      actorUserId: ctx.authContext.session.userId,
      action,
      targetType: AUDIT_TARGET_TYPES.CREDENTIAL,
      targetId: ctx.scope,
      requestMetadata: { courseId: ctx.courseId, ...metadata },
    }),
  ).pipe(
    Effect.catchTag("DatabaseError", (err) => Effect.sync(() => logServerError("auditCredentialChange", err.cause))),
  );
}
