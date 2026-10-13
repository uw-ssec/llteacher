---
type: Fact
title: "Authorization and provisioning across platform, organization, and course"
description: "Super admins provision the local org, course shells and instructor access; Org Admins own shared LLM configs, while instructors need active course membership to run courses and use their own Canvas tokens."
tags: [authz, roles, multi-tenancy, admin]
generated: { by: "codex-desktop:gpt-6.1-sol", at: "2026-10-13T20:31:48Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/middleware/roles.ts, apps/web/src/lib/services/SuperAdminService.ts, apps/web/src/db/schema/identity.ts, packages/ui]
sources:
  - resource: "PR #110"
  - resource: "PR #209"
  - resource: "PR #363"
  - resource: "issue #367"
  - resource: "PR #464"
  - resource: "issue #316"
  - resource: "issue #183"
  - resource: "issue #171"
  - resource: "issue #246"
---

## Current model (merged through 2026-10-13)

- Course authority still comes from active `course_memberships` roles (`instructor | ta | student | observer | admin`). TAs are graders, not authors; their solution/draft permissions are course-specific. Super admins have a deployment-level allowlist; Org Admins are separate organization-level members who manage the shared LLM configuration pool (PR #484).
- A platform instructor grant opens the instructor console but does not itself authorize any course. To see and run a course, the instructor also needs an active instructor membership on that course. Super admins can grant platform access, create the first local organization and a course shell, and assign one or more instructors (PR #487). Local organization creation uses deployment-scoped allowed domains and does not create or edit a WorkOS organization.
- Canvas is optional for a local shell. An assigned instructor supplies an encrypted, instructor-scoped Canvas token, can link their course to Canvas, import its roster, and assign TAs. The token is reusable across that instructor's courses, not shared with other instructors (PR #487).
- Course Setup supports adding and editing instructor memberships (PR #491). Removing one instructor from a course does not revoke their platform access or memberships on other courses. The course edit path may remove the last instructor; platform-wide instructor revocation is a separate, explicitly confirmed operation that refuses to orphan a course.

## Superseded observations

Before PR #484 there was no Org Admin membership, and before PR #487 there was no application path to create a local organization or course shell. Those earlier gaps are no longer current. Do not infer that an instructor who has only a platform grant is assigned to a course.

## Still separate

Open TA deprovisioning and transcript-access questions must be checked against their current issues before changing permission logic; the merged provisioning work did not establish their resolution.
