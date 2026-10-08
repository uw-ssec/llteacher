import { Hono } from "hono";
import { Cause, Effect } from "effect";
import { SignatureVerificationException } from "@workos-inc/node";
import { getWorkOS } from "../../lib/workos";
import { deactivateByWorkosUserId } from "../repositories/users";
import { recordAuditEvent } from "../repositories/auditEvents";
import { claimWebhookEvent, recordWebhookEvent } from "../repositories/webhookEvents";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { UserIdentityService } from "../../lib/services/UserIdentityService";
import { AUDIT_ACTIONS } from "../utils/audit";
import { logServerError } from "../utils/errors";
import type { AppEnv } from "../context";
import { BadRequest, DatabaseError } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { external, query } from "../effect/services";

/** Handles WorkOS lifecycle webhooks (issue #95, extended by #142). v0
 *  scope was deprovisioning only (`user.deleted`); this also handles
 *  `user.updated` (identity sync -- re-encrypt email, refresh blind index).
 *  `organization_membership.*` events are deliberately unhandled: WorkOS
 *  organization membership in this app is used ONLY to resolve the
 *  domain-allowlist policy at login time (DomainAllowlistService, via
 *  organizations.workos_organization_id) -- it never feeds course_memberships
 *  or role, which are entirely Canvas-roster-driven (#32/#74) and unrelated
 *  to WorkOS org membership. That resolution re-runs fresh on every login
 *  from the live WorkOS auth response, so there is nothing for a
 *  organization_membership webhook to invalidate or sync app-side; the
 *  unknown-event branch below acknowledges it like any other out-of-scope
 *  event type.
 *
 *  Verification uses the WorkOS SDK's own workos.webhooks.constructEvent(),
 *  not a hand-rolled HMAC check -- it already verifies the signature,
 *  enforces a timestamp tolerance (replay protection), and resolves to a
 *  Web Crypto (not Node crypto) implementation automatically in the
 *  Workers runtime via the package's `workerd` export condition.
 *
 *  Event persistence (#95's other unchecked requirement): every verified
 *  event is recorded in workos_webhook_events keyed by WorkOS's own event
 *  id. This is the idempotency guard for event types whose handler logic
 *  isn't independently idempotent (user.updated re-encrypts unconditionally
 *  if not deduped first) -- deactivateByWorkosUserId's own isActive=true
 *  WHERE-clause guard remains a second, redundant safety net for
 *  user.deleted specifically. A prior "failed" status is NOT treated as a
 *  duplicate, so a genuine processing failure gets reprocessed on WorkOS's
 *  retry rather than being silently skipped forever. recordWebhookEvent
 *  (#150) redacts email/name/photo out of the stored payload -- this
 *  handler passes event.data through as-is, the redaction happens at the
 *  repository write boundary, not here.
 *
 *  Dedup is an atomic claim (#151, claimWebhookEvent), not a separate
 *  find-then-later-insert -- two concurrent identical deliveries can't
 *  both pass the check before either has written anything. */
export const workosWebhookHandler = effectHandler((c) => Effect.gen(function* () {
  // 401s here carry their own sentence ("Missing signature" / "Invalid
  // signature"), which WorkOS's delivery log shows an operator -- so they
  // are answered directly rather than as Unauthorized's fixed body.
  const sigHeader = c.req.header("workos-signature");
  if (!sigHeader) {
    return c.json({ error: "Missing signature" }, 401);
  }

  // #151: an unset WORKOS_WEBHOOK_SECRET makes every webhook fail signature
  // verification below and 401 -- fails closed, so not a security issue,
  // but with nothing to distinguish it from a genuinely invalid signature
  // an operator has no way to tell "misconfigured" from "someone's
  // hammering this endpoint with garbage." Logged distinctly so it shows
  // up as a config problem, not routine auth noise; still 401 either way.
  const secret = c.env.WORKOS_WEBHOOK_SECRET;
  if (!secret) {
    logServerError("workosWebhookHandler", new Error("WORKOS_WEBHOOK_SECRET is not configured"));
    return c.json({ error: "Invalid signature" }, 401);
  }

  // c.req.text() consumes the request body stream -- read it exactly once,
  // before any JSON parsing, and reuse the result. constructEvent expects a
  // parsed object (it does its own JSON.stringify internally to compute the
  // signature), not the raw string.
  const rawBody = yield* Effect.promise(() => c.req.text());
  const payload = yield* Effect.try({
    try: (): unknown => JSON.parse(rawBody),
    catch: () => new BadRequest({ message: "Invalid JSON" }),
  });

  // Constructing the client is its own step: a missing WORKOS_API_KEY is a
  // deployment fault (ExternalServiceError -> 503), not an untrusted request.
  const workos = yield* external("workos", "getWorkOS", async () => getWorkOS(c.env.WORKOS_API_KEY));
  const verified = yield* external(
    "workos",
    "webhooks.constructEvent",
    () => workos.webhooks.constructEvent({ payload, sigHeader, secret }),
    [SignatureVerificationException],
  ).pipe(
    Effect.map((event) => ({ event })),
    Effect.catch((err) => {
      // Bad signature, stale timestamp, or malformed sigHeader -- all the
      // same "this request isn't trusted" outcome (401), never a 5xx. Not
      // logged as a server error: an invalid signature is a routine, expected
      // occurrence (misconfiguration, retries against a rotated secret, or a
      // genuine forgery attempt), not a bug in this code. Anything else
      // constructEvent throws (it verifies locally, then deserializes the
      // payload) is still answered 401 as before, but logged: it is not
      // routine.
      if (!(err instanceof SignatureVerificationException)) {
        logServerError("workosWebhookHandler", err.cause, { tag: err._tag, service: err.service, operation: err.operation });
      }
      return Effect.succeed({ response: c.json({ error: "Invalid signature" }, 401) });
    }),
  );
  if ("response" in verified) return verified.response;
  const { event } = verified;

  // #151: atomic claim replaces a separate find-then-later-insert dedup
  // check, which left a TOCTOU window where two concurrent identical
  // deliveries could both pass the check before either had written
  // anything. See claimWebhookEvent's doc comment for the exact race it
  // closes and why a "claimed" status exists. A DatabaseError here is the
  // generic 503, which WorkOS retries.
  const claimed = yield* query(
    "claimWebhookEvent",
    (db) => claimWebhookEvent(db, { id: event.id, eventType: event.event }),
  );
  if (!claimed) {
    return c.json({ received: true, duplicate: true });
  }

  return yield* Effect.gen(function* () {
    let status: "processed" | "skipped" = "processed";
    if (event.event === "user.deleted") {
      // #151: deactivateByWorkosUserId no longer short-circuits to null
      // just because the user was already inactive -- a retry (this
      // delivery, after a prior attempt's audit write failed) still needs
      // real org scopes back so the audit actually gets written this time.
      const result = yield* query("deactivateByWorkosUserId", (db) => deactivateByWorkosUserId(db, event.data.id));
      if (result) {
        // The webhook payload carries no org context -- audit against
        // every org this user actually belonged to, discovered via their
        // course memberships.
        yield* query("recordAuditEvent", (db) =>
          Promise.all(
            result.orgScopes.map((scope) =>
              recordAuditEvent(db, scope, {
                actorUserId: null,
                action: AUDIT_ACTIONS.USER_DEPROVISIONED,
                targetType: "user",
                targetId: result.userId,
              }),
            ),
          ),
        );
      }
    } else if (event.event === "user.updated") {
      // #151: a missing/blank email is a poison message otherwise --
      // IdentityCipher.normalizeEmail calls .trim() on it unconditionally,
      // so a null/undefined email throws, which without this guard would
      // 500 -> "failed" -> WorkOS retries the exact same poison payload
      // until its retry schedule exhausts, never succeeding. Treated as
      // out-of-scope-for-this-handler (skipped), not a processing error.
      const email = event.data.email;
      if (typeof email === "string" && email.trim().length > 0) {
        // A missing/malformed ENCRYPTION_KEY is a defect -- caught below
        // with every other processing failure, so it is still the 500
        // WorkOS retries rather than a dropped event.
        const cipher = yield* Effect.promise(async () => new IdentityCipher(await loadIdentityCipherKeys(c.env)));
        yield* query(
          "handleEmailUpdated",
          (db) => new UserIdentityService(cipher, db).handleEmailUpdated(event.data.id, email),
        );
      } else {
        console.log(
          `[workosWebhookHandler] user.updated event ${event.id} has no usable email -- skipped, not processed`,
        );
        status = "skipped";
      }
    } else {
      // Acknowledged, not processed -- see the module doc comment above
      // for why this isn't an error. Logged (not just silently ack'd) so
      // an operator can see what WorkOS is actually sending.
      console.log(`[workosWebhookHandler] acknowledged unhandled event type: ${event.event}`);
      status = "skipped";
    }

    yield* query("recordWebhookEvent", (db) =>
      recordWebhookEvent(db, {
        id: event.id,
        eventType: event.event,
        payload: event.data,
        status,
      }),
    );
    return c.json({ received: true });
  }).pipe(
    // A genuine failure processing a *verified* event (DB down, a missing
    // key, etc.) -- the one case that should surface as a server error and
    // let WorkOS's retry-on-failure behavior do its job. Answered 500 (not
    // the generic 503) as before. catchCause rather than catchTag: a defect
    // here must be retried by WorkOS too, not swallowed into the bridge's
    // 503 without the "failed" record. Recording "failed" is best-effort:
    // if even that write fails, don't let it mask the real 500 the caller
    // needs to see.
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const failure = Cause.squash(cause);
        logServerError("workosWebhookHandler", failure instanceof DatabaseError ? failure.cause : failure);
        yield* query("recordWebhookEvent", (db) =>
          recordWebhookEvent(db, {
            id: event.id,
            eventType: event.event,
            payload: event.data,
            status: "failed",
          }),
        ).pipe(Effect.ignore);
        return c.json({ error: "Internal error" }, 500);
      }),
    ),
  );
}));

// Sub-app preserved for direct unit testing; production routing happens via
// app.post("/api/webhooks/workos", workosWebhookHandler) in server/index.ts.
export const webhooksWorkos = new Hono<AppEnv>();
webhooksWorkos.post("/", workosWebhookHandler);
