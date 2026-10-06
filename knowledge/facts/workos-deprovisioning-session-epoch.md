---
type: Fact
title: Revoking stateless WorkOS sessions with a per-user session epoch
description: "Sealed-cookie sessions are revoked by comparing the cookie's sessionEpoch with users.session_epoch in roles middleware on every request; WorkOS user.deleted webhooks bump the epoch, and reactivation restores only what deactivation dropped."
tags: [auth, workos, webhooks, sessions, security]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/routes/webhooksWorkos.ts", "apps/web/src/server/middleware/roles.ts", "apps/web/src/lib/services/UserIdentityService.ts"]
sources:
  - resource: "PR #110"
  - resource: "PR #127"
  - resource: "issue #95"
  - resource: "issue #142"
  - resource: "issue #150"
  - resource: "issue #151"
---

## Problem

PR #110 used WorkOS AuthKit with **stateless sealed-cookie sessions**. A stateless cookie cannot be revoked by itself, so deprovisioning a user in WorkOS would not end their live sessions (#95's open design question).

## Design (PR #127)

- `users.is_active` and `users.session_epoch` were added in migration 0011.
- `rolesMiddleware` compares the cookie's epoch with the live DB value on **every** authenticated request. The check rides on the per-request membership query, so it costs no extra round trip. The reviewer enumerated the route-to-middleware matrix and confirmed no authenticated route skips it, including `/api/chat` and `/api/profile`.
- `POST /api/webhooks/workos` verifies WorkOS's signature with the SDK's `constructEvent` (not a hand-rolled HMAC). On a verified `user.deleted` it deactivates the user, bumps the epoch, and records an audit event.
- **Reactivation** on a later legitimate login sets `is_active` back to true **without** touching the epoch. Old cookies stay dead and the new login gets a fresh cookie. Legacy cookies without an epoch fail closed.
- When a user is deprovisioned, their course memberships are dropped with `dropped_reason`. Reactivation restores only what *that* deactivation dropped and leaves, for example, a separate roster removal in place.

## Hardening from review (#150, #151)

- `workos_webhook_events` is an append-only log keyed by WorkOS event id, used for idempotency and replay. Its payload is **redacted to an allowlist** at the repository write boundary, so emails and names never land in the log.
- The dedup claim is atomic, which closed a TOCTOU race. Poison `user.updated` messages are guarded. A deprovisioning audit event can no longer be lost on a retried delivery.
- `user.updated` re-encrypts the email and refreshes the blind index. `organization_membership.*` events are deliberately not handled, because WorkOS org membership only resolves the domain allowlist at login.

## Rule

Any new authenticated route must sit behind `rolesMiddleware`. Webhook routes must be session-exempt and signature-verified.
