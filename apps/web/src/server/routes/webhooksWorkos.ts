import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { getWorkOS } from "../../lib/workos";
import { makeDb } from "../../db/client";
import { workosWebhookEvents } from "../../db/schema";
import { deactivateByWorkosUserId } from "../repositories/users";
import { recordAuditEvent } from "../repositories/auditEvents";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { UserIdentityService } from "../../lib/services/UserIdentityService";
import { logServerError } from "../utils/errors";
import type { AppEnv } from "../context";

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
 *  retry rather than being silently skipped forever. */
export async function workosWebhookHandler(c: Context<AppEnv>) {
  const sigHeader = c.req.header("workos-signature");
  if (!sigHeader) {
    return c.json({ error: "Missing signature" }, 401);
  }

  // c.req.text() consumes the request body stream -- read it exactly once,
  // before any JSON parsing, and reuse the result. constructEvent expects a
  // parsed object (it does its own JSON.stringify internally to compute the
  // signature), not the raw string.
  const rawBody = await c.req.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const workos = getWorkOS(c.env.WORKOS_API_KEY);
  let event: Awaited<ReturnType<typeof workos.webhooks.constructEvent>>;
  try {
    event = await workos.webhooks.constructEvent({
      payload,
      sigHeader,
      secret: c.env.WORKOS_WEBHOOK_SECRET,
    });
  } catch {
    // Bad signature, stale timestamp, or malformed sigHeader -- all the
    // same "this request isn't trusted" outcome (401), never a 500. Not
    // logged as a server error: an invalid signature is a routine, expected
    // occurrence (misconfiguration, retries against a rotated secret, or a
    // genuine forgery attempt), not a bug in this code.
    return c.json({ error: "Invalid signature" }, 401);
  }

  const db = makeDb(c.env.DATABASE_URL);

  const existingEvent = await db.query.workosWebhookEvents.findFirst({
    where: eq(workosWebhookEvents.id, event.id),
  });
  if (existingEvent && existingEvent.status !== "failed") {
    return c.json({ received: true, duplicate: true });
  }

  let status: "processed" | "skipped" = "processed";
  try {
    if (event.event === "user.deleted") {
      // Idempotent by construction (see deactivateByWorkosUserId): a
      // duplicate delivery -- WorkOS retries on failure -- finds no active
      // user on the second attempt and is a harmless no-op.
      const result = await deactivateByWorkosUserId(db, event.data.id);
      if (result) {
        // The webhook payload carries no org context -- audit against
        // every org this user actually belonged to, discovered via their
        // course memberships.
        await Promise.all(
          result.orgScopes.map((scope) =>
            recordAuditEvent(db, scope, {
              actorUserId: null,
              action: "user.deprovisioned",
              targetType: "user",
              targetId: result.userId,
            }),
          ),
        );
      }
    } else if (event.event === "user.updated") {
      const cipher = new IdentityCipher(await loadIdentityCipherKeys(c.env));
      await new UserIdentityService(cipher, db).handleEmailUpdated(
        event.data.id,
        event.data.email,
      );
    } else {
      // Acknowledged, not processed -- see the module doc comment above
      // for why this isn't an error. Logged (not just silently ack'd) so
      // an operator can see what WorkOS is actually sending.
      console.log(`[workosWebhookHandler] acknowledged unhandled event type: ${event.event}`);
      status = "skipped";
    }

    await db
      .insert(workosWebhookEvents)
      .values({ id: event.id, eventType: event.event, payload: event.data, status })
      .onConflictDoUpdate({
        target: workosWebhookEvents.id,
        set: { status },
      });
  } catch (err) {
    // A genuine failure processing a *verified* event (DB down, etc.) --
    // the one case that should surface as a server error and let WorkOS's
    // retry-on-failure behavior do its job. Recording "failed" is
    // best-effort: if even that write fails, don't let it mask the real
    // 500 the caller needs to see.
    logServerError("workosWebhookHandler", err);
    await db
      .insert(workosWebhookEvents)
      .values({ id: event.id, eventType: event.event, payload: event.data, status: "failed" })
      .onConflictDoUpdate({ target: workosWebhookEvents.id, set: { status: "failed" } })
      .catch(() => {});
    return c.json({ error: "Internal error" }, 500);
  }

  return c.json({ received: true });
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.post("/api/webhooks/workos", workosWebhookHandler) in server/index.ts.
export const webhooksWorkos = new Hono<AppEnv>();
webhooksWorkos.post("/", workosWebhookHandler);
