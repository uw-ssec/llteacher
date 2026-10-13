---
type: Decision
title: "Canvas integration uses an instructor-pasted API token and roster sync, with LTI 1.3 deferred"
description: "Canvas roster sync uses an encrypted instructor-scoped API token reusable across that instructor's courses; Canvas linking is optional after local course creation, and LTI 1.3 remains deferred."
tags: [canvas, lms, integration, roster]
generated: { by: "codex-desktop:gpt-6.1-sol", at: "2026-10-13T20:30:47Z" }
status: stable
governance: context
code_refs: [apps/web/src/lib/canvas-api.ts, apps/web/src/lib/services/CanvasRosterSyncService.ts, apps/web/src/server/routes/canvasCredentials.ts, apps/web/src/server/routes/canvasSync.ts, apps/web/src/server/repositories/organizationCredentials.ts, apps/web/src/server/repositories/lmsIntegrations.ts, apps/web/src/server/repositories/roster.ts, docs/operations/canvas-token-setup.md]
sources:
  - resource: docs/superpowers/plans/2026-09-10-m11-canvas-integration.md
  - resource: docs/superpowers/plans/2026-06-01-llteacher-platform-generalization.md
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: docs/notes/transcript-2026-07-28.md
  - resource: "PR #457"
  - resource: commit 44266a2
  - resource: commit 905bfea
  - resource: "PR #462"
  - resource: milestone M11
  - resource: "issue #58"
  - resource: "issue #59"
  - resource: "issue #60"
  - resource: "issue #85"
---

## Spec proposed
The generalization plan (phase 5) and data-model §3.4 planned **Canvas LTI 1.3**: OIDC launch, NRPS rosters, and deep linking, with grade passback as a v1 non-goal. They expected UW-IT developer-key provisioning to be the calendar bottleneck. On 2026-07-28 the team learned that institutional LTI and API access was blocked until about Sept-Oct. M11 therefore chose a token-based path.

## Initial implementation (PR #457, 2026-09-15; superseded where noted below)
- **Token storage (decision 1):** a nullable `encryptedSecret` on `organization_credentials`, encrypted with the same AES-256-GCM `IdentityCipher`. A CHECK enforces exactly one of `secretRef` or `encryptedSecret`. The token is masked at response time, never stored masked or logged. The LLM credential path still reads only `secretRef`.
- **LMS integration (decision 2):** the LTI triple is nullable, behind a partial unique index. The row adds `canvasBaseUrl` (per org, not hard-coded to UW) and sync-status columns.
- **WorkOS pre-population (decision 3):** handled by reuse. Sync creates **pending users** through `roster.ts`'s `upsertCourseMembers`, and they are claimed by email blind index on first WorkOS login.
- **Sync (decision 4):** fetch every page first, then write in three passes: known enrollment ids updated authoritatively, new ones resolved by email, missing ones soft-dropped as `roster_removal`. Duplicate multi-section enrollments are deduped by highest-authority role.
- **Role mapping (decision 5):** Teacher → instructor, Ta → ta, Student → student, Observer → observer, Designer → instructor. Anything else is reported per enrollment.
- **Pagination (decision 6):** follows `Link` headers, with a bounded back-off on rate-limit 403s.
- A Students-tab import followed in commit `905bfea`.

## Rejected alternatives
- LTI 1.3 now.
- The WorkOS bulk-invite API.
- Course creation from Canvas.
- Multiple credentials per org (`apiCredentialId` was written but not used in the initial implementation). This historical rejection was superseded by instructor-scoped credentials in PR #487.

## Consequences
- Instructors handle personal Canvas tokens (see the runbook).
- When LTI arrives, launches still need the `sub` → user and `context_id` → course mapping from data-model §3.4.

## From the issue tracker and reviews

## Decision (transcript 2026-07-28, milestone M11)

Institutional Canvas access (an LTI developer key or a university API key) needs UW-IT and Instructure approval. Another UW project reported waiting until about Sept–Oct, and Instructure was cautious after recent security incidents. A professor on one of the CDI projects had generated a personal Canvas API token, which showed that professors can get tokens themselves. Decision: **instructors paste their own Canvas token into the admin console**. It is shown obscured, with only the last characters visible. Sign-in stays WorkOS with UW accounts.

## Implementation

- **PR #457:** `organization_credentials` gained an `encrypted_secret` shape (AES-256-GCM via the existing `IdentityCipher`) alongside the env-binding `secret_ref` used for LLM keys. `lms_integrations` LTI columns became nullable for a token-only connection. Roster sync pulls Canvas enrollments and **reuses the existing CSV/NetID provisioning pipeline**, so pending users are created and then claimed on first WorkOS login, the same as a manual roster import. Sync is paginated and idempotent, and applies add, update and remove.
- **PR #462:** an "Import from Canvas" button on the Students tab calls the same course-scoped `/canvas/sync` endpoint. Error text maps to three actionable cases (missing token, rejected or expired token, course not linked), each with an in-console "Go to Canvas" view switch. Other failures are shown as reported, never mislabelled.
- Operator and instructor runbook: `docs/operations/canvas-token-setup.md`.

## Deferred

LTI 1.3 launch, course mapping and NRPS roster sync (#58–#60) sit outside any milestone. #85 tracks the institutional-access status and the reference token configuration (scopes, expiry behaviour).

## Caveats

A personal token carries the instructor's full Canvas permissions. Roster sync depends on pending-user claim by blind index, so it is also exposed to bugs/blind-index-key-drift-forks-accounts.

# Related Concepts
- [Roles live on per-course memberships instead of global Teacher/Student profiles](course-membership-roles.md): Roster sync creates course memberships

## Current credential ownership (PR #487, merged 2026-10-08)

Canvas API tokens are encrypted and instructor-scoped, not course-scoped or shared across the organization. One instructor can reuse their own token across multiple courses they teach; another instructor cannot use that token to sync a course. A super admin creates the local organization and course shell, assigns the instructor, and leaves Canvas linking optional. The instructor signs in, supplies their own Canvas token, optionally links the shell to Canvas, and can import the roster. This changed the initial organization-credential scope described above without changing the decision to defer LTI 1.3. Do not infer a Canvas token or linked Canvas course from the presence of a local course shell.
