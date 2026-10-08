---
type: Fact
title: Project state as of 2026-10-06
description: "As of 2026-10-08: parity milestones M1-M5 and M11 are closed; the first AWS production release is being brought up and needs an Org Admin granted per org; RAG, analytics, FERPA, branding, course management and M12 remain open."
tags: [project, status, roadmap]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:53:11Z" }
status: stable
governance: context
code_refs: [infra/account/bootstrap.sh, infra/README.md, .github/workflows/release.yml, docs/adr/0001-operator-owned-production-secrets.md]
sources:
  - resource: "issue #64"
  - resource: "issue #65"
  - resource: "issue #66"
  - resource: "issue #78"
  - resource: "issue #81"
  - resource: "issue #82"
  - resource: "issue #83"
  - resource: "issue #84"
  - resource: "issue #250"
  - resource: "issue #258"
  - resource: "issue #320"
  - resource: "issue #367"
  - resource: "issue #455"
  - resource: "issue #456"
  - resource: "PR #435"
  - resource: "PR #436"
  - resource: "PR #412"
  - resource: "PR #473"
---

Snapshot taken 2026-10-06 from GitHub (`-R uw-ssec/llteacher`): 417 issues, 126 open and 291 closed. 47 PRs merged, 3 open.

## Done (merged to `staging`)

- Auth (WorkOS, encrypted PII, TA capabilities, super-admin allowlist via PR #464), the runtime data layer, homework/submission parity, chat parity including WebR R execution and the instructor transcript viewer, the live admin console with grading and export, and the Canvas instructor-token roster sync.
- The knowledge base is a filesystem-authoritative OKF bundle searched with BM25 (PR #459). It persists to S3 snapshots (PR #461).
- AWS/Pulumi production stack code: ECS Fargate, ALB, RDS pgvector, S3, two Secrets Manager secrets, and a scripted account bootstrap.

## In flight

- **First production release.** PRs #465–#473 (2026-09-29 to 10-01) fixed one release blocker after another: a new-stack config refresh, swallowed Pulumi errors, missing ELB/RDS/ECS service-linked roles, and the operator-owned domain and certificate. The last recorded release attempt reached the candidate-migration step. Whether production is now live is not recorded on GitHub (inferred: probably not confirmed yet).
- Open PRs as of 2026-10-06 were resolved on 2026-10-08: #435 merged reduced to its one missing piece (Retry-After now reports the time left in the rate-limit window, from chat, conversation creation and feedback); #436 closed, superseded by 0c9a9f9; #412 closed, superseded by the M4 closeout 9743dd7.

## Since 2026-10-06

- **M3, M4 and M5 are closed.** #442 (per-org bound in SQL, PR #482), #165 (self-assessment prompts and export, PR #481), and #367 (Org Admin role and course-scoped LLM configs, PR #484) landed on 2026-10-08.
- **Action before the next production release:** no organization has an Org Admin until a super admin grants one (`POST /api/organizations/:organizationId/admins`); until then only super admins can change an org's shared LLM configs or default.
- **Known gaps carried forward:** `LLM_DEGRADED_MODEL` is not plumbed to the AWS task (see decisions/llm-provider-gateway-and-failover); the Canvas credential keeps its course-to-org widening (see decisions/org-admin-role-and-course-scoped-configs).

## Open and important

- **M12 must-complete:** CI jobs #62, environments #63, Django SQLite to RDS ETL #64, Django archive #65, epic #66, Pulumi baseline #81 and re-platform #82 (largely satisfied by #458/#461, but still open), Playwright E2E #83, backup/DR #84, error reporting #97, and stakeholder sandbox and setup docs #455/#456 (#455 should target AWS, not Neon).
- **M7 RAG** issues #40–#44 and #79 are all open and need reconciling with the OKF design.
- **M9 FERPA:** audit viewer #50, retention #51, PII egress guard #52, data-flow doc #53, accommodations encryption #137, plus the pending visibility decision #78.
- **Correctness debt:** stale grades after resubmission #258 and attempt model #250, non-rotatable blind index #320, per-course LLM budget #282, CSP #375, and about 27 `non-blocking` UI/a11y bugs.
- M6, M8, M10 and M13 are essentially not started.

# Related Concepts
- [Milestones M1-M13 and what each delivered](milestones.md): Open work is tracked against these milestones
- [First AWS production release blockers: new stack refresh and missing service-linked roles](../bugs/first-production-release-blockers.md): The first production release is the active frontier
- [Several sessions work this repository at once; re-check staging before and during an issue](../facts/check-for-concurrent-work.md): Read before picking up open work
