import { Hono, type Context } from "hono";
import { getWorkOS } from "../../lib/workos";
import { makeDb } from "../../db/client";
import { deactivateByWorkosUserId } from "../repositories/users";
import { recordAuditEvent } from "../repositories/auditEvents";
import { logServerError } from "../utils/errors";
import type { AppEnv } from "../context";

/** Handles WorkOS lifecycle webhooks (issue #95). v0 scope is deprovisioning
 *  only -- `user.deleted` -- deactivating the app user and revoking every
 *  session cookie issued before now (see repositories/users.ts's
 *  deactivateByWorkosUserId and the sessionEpoch mechanism in lib/session.ts).
 *  `user.updated` (email sync) and organization-membership events are
 *  deliberately out of scope for this pass; every event type this handler
 *  doesn't recognize is acknowledged with 200, not ignored with an error --
 *  WorkOS retries on a non-2xx response, and there is no reason to make it
 *  retry forever for an event type this code will never process.
 *
 *  Verification uses the WorkOS SDK's own workos.webhooks.constructEvent(),
 *  not a hand-rolled HMAC check -- it already verifies the signature,
 *  enforces a timestamp tolerance (replay protection), and resolves to a
 *  Web Crypto (not Node crypto) implementation automatically in the
 *  Workers runtime via the package's `workerd` export condition. */
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

  try {
    if (event.event === "user.deleted") {
      // Idempotent by construction (see deactivateByWorkosUserId): a
      // duplicate delivery of the same event -- WorkOS retries on
      // failure -- finds no active user on the second attempt and is a
      // harmless no-op, not tracked via a separate event-id ledger.
      const result = await deactivateByWorkosUserId(makeDb(c.env.DATABASE_URL), event.data.id);
      if (result) {
        // The webhook payload carries no org context -- audit against
        // every org this user actually belonged to, discovered via their
        // course memberships.
        const db = makeDb(c.env.DATABASE_URL);
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
    } else {
      // Acknowledged, not processed -- see the module doc comment above
      // for why this isn't an error. Logged (not just silently ack'd) so
      // an operator can see what WorkOS is actually sending, e.g. to scope
      // a future pass that handles more event types.
      console.log(`[workosWebhookHandler] acknowledged unhandled event type: ${event.event}`);
    }
  } catch (err) {
    // A genuine failure processing a *verified* event (DB down, etc.) --
    // the one case that should surface as a server error and let WorkOS's
    // retry-on-failure behavior do its job.
    logServerError("workosWebhookHandler", err);
    return c.json({ error: "Internal error" }, 500);
  }

  return c.json({ received: true });
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.post("/api/webhooks/workos", workosWebhookHandler) in server/index.ts.
export const webhooksWorkos = new Hono<AppEnv>();
webhooksWorkos.post("/", workosWebhookHandler);
