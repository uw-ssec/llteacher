---
type: Decision
title: "WorkOS AuthKit for identity, with a stateless AES-GCM sealed session cookie"
description: "M1 replaced fixture identity with WorkOS AuthKit login/callback/logout, a 7-day stateless AES-256-GCM cookie (llt_session) holding only userId/workosUserId, an email-domain allowlist, and a super-admin allowlist."
tags: [auth, workos, session, security]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/lib/session.ts, apps/web/src/lib/workos.ts, apps/web/src/server/routes/auth.ts, apps/web/src/server/middleware/auth.ts, apps/web/src/lib/services/DomainAllowlistService.ts, apps/web/src/lib/services/SuperAdminService.ts, apps/web/src/server/routes/webhooksWorkos.ts]
sources:
  - resource: docs/superpowers/plans/2026-07-31-m1-auth-workos.md
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: "PR #110"
  - resource: commit 3a73be8
  - resource: commit 7ffd96f
---

## Spec proposed
The port plan's phase 2 left these open: AuthKit or a custom UI, KV or cookie sessions, where roles are stored, and how domain restriction works. The M1 plan (2026-07-31, epic #13) settled them:
- AuthKit hosted flow.
- A stateless sealed cookie with no server-side session store, carrying a payload with no PII of concern.
- Every `/api/*` route authenticated except `/api/auth/login|callback|logout`.
- Roles from `course_memberships`, resolved once per request.
- WorkOS webhooks (#95) deferred because they need a session-revocation design.

## Implemented
- `apps/web/src/lib/session.ts` defines cookie `llt_session` with a 7-day TTL and AES-GCM with a random IV. Tampered or expired cookies unseal to null. The TTL is independent of the WorkOS session lifetime.
- `DomainAllowlistService` is a "parity port of Django's ALLOWED_EMAIL_DOMAINS" with default `uw.edu`, an org-level override, and grandfathering for existing users.
- `SuperAdminService` hard-codes a two-email super-admin allowlist and lets super admins provision instructors (#316, commit `7ffd96f`).
- A WorkOS webhook route now exists (`webhooksWorkos.ts`, with a `webhook_events` table in migration 0012), so #95 was later picked up at least in part. Whether sessions are revoked on webhook events was not confirmed in code.
- The callback is derived as `${APP_URL}/api/auth/callback`. The webhook is `${APP_URL}/api/webhooks/workos`.

## Why
AuthKit ships fastest and is SSO/SAML-ready for UW NetID. A stateless cookie needs no session store on the Worker or in ECS.

## Rejected alternatives
- Custom login UI.
- Workers KV or D1 session storage.
- Storing role in WorkOS metadata.
- Migrating Django passwords (users re-authenticate).

## Consequences
A stolen cookie stays valid until it expires (up to 7 days) unless revocation is added. Rotating `SESSION_SECRET` invalidates every session.

# Related Concepts
- [Authentication and authorization](../architecture/auth-and-authorization.md): Authentication as implemented
- [Revoking stateless WorkOS sessions with a per-user session epoch](../facts/workos-deprovisioning-session-epoch.md): How stateless sessions are revoked
