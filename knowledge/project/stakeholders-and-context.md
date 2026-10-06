---
type: Fact
title: Stakeholders and CDI shared-platform context
description: "LLTeacher is SSEC's candidate base for a shared platform serving four UW CDI-funded AI tutoring projects (stats, economics, clinical informatics, engineering code tutoring) with fall-quarter pilots; roles, not names."
tags: [project, stakeholders, cdi, ssec]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: context
code_refs: [docs/notes]
sources:
  - resource: "issue #67"
  - resource: "issue #85"
  - resource: "issue #78"
  - resource: "PR #445"
  - resource: "PR #457"
---

## Who is involved (roles)

- **SSEC engineers** (UW eScience Scientific Software Engineering Center) do the platform rewrite, the reviews and the infrastructure. GitHub handles seen in the tracker: `cdcore09` and `KshitijDani`. SSEC's mandate is generalizable, sustainable infrastructure, not only one course's needs.
- **SSEC leadership / project lead** owns the timeline and stakeholder communication.
- **PIs of four UW CDI-funded tutoring projects**, each with a course:
  1. **Statistics**: the original LLTeacher, which served an intro stats course on Django. Its original authors keep developing their own fork (upstream `RedBeardLab/llteacher`) in parallel (transcript 2026-07-09).
  2. **Economics**: wants a tutor grounded in course materials, plus quizzes.
  3. **Nursing / clinical informatics**: FERPA-sensitive. This PI asked for aggregate-only views of student data (#78).
  4. **Mechanical / civil engineering**: a coding tutor. Code mode was treated as a bonus feature (transcript 2026-06-02).
- **UW-IT / Instructure** gate institutional Canvas LTI/API access, which is not expected before roughly Sept–Oct 2026 (#85, M11).

## Shared-platform idea (transcript 2026-06-02)

Instead of each PI hosting their own copy, run one shared deployment. Professors are admins who create classes, and students sign in with UW accounts. Each project pays for its own model inference from its grant, through per-org LLM configs or a gateway, while hosting is shared. The tutor and homework modes cover three of the four projects. Code mode would cover the fourth.

## Timeline

The fall quarter starts at the end of September 2026. The plan was baseline multi-user work by end of July, user-specific features by end of August, and testing in September (transcript 2026-07-09). In practice, parity work ran through September and production bring-up into October (see project/current-state).

## External dependencies

Issue #85 tracks accounts and approvals: AWS account access, the Pulumi state backend (S3 was chosen, PR #465), the WorkOS production org with UW SSO, a reference Canvas token configuration, provider data-handling terms for the FERPA doc, and coordination with the upstream fork.

# Related Concepts
- [Stakeholder requirement: usable for fall-quarter 2026 pilots](../requirements/stakeholder-fall-quarter-pilot.md): The pilot deadline stakeholders set
