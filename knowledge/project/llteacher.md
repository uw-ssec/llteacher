---
type: Reference
title: LLTeacher v2 project overview
description: "LLTeacher v2: UW AI tutoring platform being ported from a Django app to a TypeScript Turborepo on AWS; real tracker is uw-ssec/llteacher, not upstream RedBeardLab, so always pass -R to gh."
tags: [project, overview, github, workflow]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: constraint
code_refs: [package.json, turbo.json, apps/web, apps/admin, packages/ui, infra, .github/workflows/test.yml, .github/workflows/release.yml]
sources:
  - resource: "issue #67"
  - resource: "PR #106"
  - resource: "PR #457"
  - resource: "PR #459"
  - resource: "PR #461"
---

## What it is

LLTeacher is an LLM tutoring platform first built as a Django app for a UW introductory statistics course. SSEC (the UW eScience Scientific Software Engineering Center) is rebuilding it as a multi-tenant platform that other UW CDI-funded tutoring projects can share. Students chat with a tutor about sections of homework. Instructors write homeworks, set up LLM configs, look at submissions and transcripts, and grade the work.

## Stack (as of 2026-10)

- **Turborepo**: `apps/web` is the student chat plus the Hono API, `apps/admin` is the instructor console, and `packages/ui` holds shared components and the generative-UI registry. PR #106 bootstrapped it on 2026-07-30.
- **Data**: Drizzle ORM on Postgres 16 with pgvector. PII is encrypted with AES-GCM and looked up through an HMAC blind index.
- **Auth**: WorkOS AuthKit, restricted to the uw.edu domain.
- **LLM**: Vercel AI SDK v5. The LLMoxie gateway is the default provider and OpenRouter is optional.
- **Runtime**: Node 24 on ECS Fargate behind an ALB, with RDS, S3 and Secrets Manager, all provisioned by Pulumi (`infra/`). PR #459 moved the app off Cloudflare Workers and PR #461 moved the data off Neon. **AWS + Pulumi is the settled target.** Cloudflare Workers and Neon were interim only.
- The Django legacy code (`apps/accounts`, `apps/homeworks`, `src/`, `manage.py`, …) stays in the tree until cutover (#65). The repo-root `CLAUDE.md` still describes Django (see facts/stale-root-claude-md).

## Repos and branches

- **origin = `uw-ssec/llteacher`** holds the ~417 issues, 13 milestones, discussions and every PR. **upstream = `RedBeardLab/llteacher`** is the original authors' fork, which they keep developing in parallel.
- **gh trap:** in this checkout a bare `gh issue`/`gh pr` resolves to the upstream fork. Always pass `-R uw-ssec/llteacher`.
- **`staging`** is the integration branch: every merged PR since #106 targets it. **`staging`** is the GitHub default branch (checked with `gh api` on 2026-10-06) and the target of every PR since #106. **`llteacher01`** tracks the upstream Django-era history: on origin it still points at a 2025 Django-era commit about 270 commits behind `staging`. **Production releases** come from `v*` tags through `.github/workflows/release.yml`, with a protected `production` environment and OIDC.
- PRs are squash-free merge commits named `Merge pull request #N`. Large features land as milestone PRs (M4 PR1–PR5, for example) with plans and specs under `docs/superpowers/`.

# Related Concepts
- [LLTeacher v2 system overview](../architecture/system-overview.md): How the system described here is built
- [Stakeholders and CDI shared-platform context](stakeholders-and-context.md): Who the project serves and the CDI shared-platform context
- [Milestones M1-M13 and what each delivered](milestones.md): Milestone history of the port
