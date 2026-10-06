---
type: Architecture
title: Authentication and authorization
description: "WorkOS AuthKit login sets a stateless AES-GCM sealed cookie (llt_session, 7d); rolesMiddleware revokes via users.session_epoch and builds AuthContext; route guards encode instructor/grader/TA capability tiers."
tags: [architecture, auth, workos, authorization]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/lib/session.ts", "apps/web/src/server/middleware/auth.ts", "apps/web/src/server/middleware/roles.ts", "apps/web/src/server/utils/guards.ts", "apps/web/src/server/routes/auth.ts", "apps/web/src/server/routes/webhooksWorkos.ts", "apps/web/src/lib/services/SuperAdminService.ts", "apps/web/src/server/releaseGate.test.ts"]
sources:
  - resource: "apps/web/src/lib/session.ts"
  - resource: "apps/web/src/server/middleware/roles.ts"
  - resource: "apps/web/src/server/index.ts"
---

**Login.** `/api/auth/login` redirects to WorkOS AuthKit (full top-level redirect, compatible with COOP/COEP); `/api/auth/callback` reconciles the WorkOS user with a `users` row (seeded/rostered users are `is_pending` and get claimed by email blind index) and sets the `llt_session` cookie. There is no server session store: the cookie is AES-256-GCM over `{userId, workosUserId, workosSessionId, sessionEpoch, issuedAt, expiresAt}` keyed by `SESSION_SECRET`. Rotating `SESSION_SECRET` logs everyone out.

**Revocation.** `rolesMiddleware` compares the cookie's `sessionEpoch` and `users.is_active` against the DB on every request (same round-trip as the membership load). WorkOS webhooks (`/api/webhooks/workos`, signature-verified with `WORKOS_WEBHOOK_SECRET`) bump the epoch to revoke one user.

**Public paths** are a closed set in `PUBLIC_API_PATHS` (health, auth login/callback/logout, workos webhook). A new `/api/auth/*` endpoint is NOT public until added there.

**AuthContext** exposes `isMemberOf`, `isInstructorOf` (authoring), `isGraderOf` (reading student work: instructor/admin/TA), `canViewSolutionsIn`, `canViewDraftsIn` (per-TA flags from `resolveTaCapabilities` in @llteacher/ui), `isSuperAdmin`, `isPlatformInstructor`.

**Guard tiers (server/utils/guards.ts):** authoring and grade writes use `requireInstructorOf`; grading reads use `requireGraderOf(posture)` where posture is `gates-unreleased` or `no-unreleased-content`. `releaseGate.test.ts` fails until every grader-tier route declares a posture. Platform grants use `requireSuperAdmin`.

**Super admins** are a hardcoded email allowlist in `SuperAdminService.SUPER_ADMIN_EMAILS`, compared by blind index (emails are stored encrypted). Editing it grants full cross-org access immediately; treat like a secret change.

**Known tracked gap (#367):** LLM configs and the Canvas credential are org-level resources edited by any instructor of any course in the org; the fix is an Org Admin role, not a guard tweak.
