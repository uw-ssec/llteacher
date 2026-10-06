---
type: Architecture
title: CI and release pipeline
description: "test.yml (PRs, pushes to llteacher01) runs a migration-index collision check plus Postgres-backed migrate/seed/typecheck/test/build and an ECS image smoke; release.yml on v* tags builds, tests and deploys a candidate task to production."
tags: [architecture, ci, github-actions, release]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:36Z" }
status: stable
governance: constraint
code_refs: [.github/workflows/test.yml, .github/workflows/release.yml, infra/scripts/aws-release-common.sh, infra/scripts/prepare-aws-release.sh, infra/scripts/run-aws-migrations.sh, infra/src/validate-production-inputs.ts, Dockerfile.aws]
sources:
  - resource: .github/workflows/test.yml
  - resource: .github/workflows/release.yml
  - resource: infra/README.md
  - resource: bae1cb6
  - resource: 871941b
---

**test.yml** (on every `pull_request` and pushes to `llteacher01`, the main branch; read-only token; concurrency cancels stale runs):

1. `migration-index-collision` (PRs only): diffs `apps/web/src/db/migrations/NNNN_*.sql` between PR base and head; fails if the PR adds a file whose 4-digit index exists on base under another name.
2. `web` job with a `pgvector/pgvector:pg16` service (`DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher`): `npm ci` -> generate throwaway `ENCRYPTION_KEY`/`BLIND_INDEX_KEY` -> install psql and okf v0.3.0 (checksum-verified) -> `psql -f apps/web/src/db/init/01_extensions.sql` -> `npm run db:migrate` (in apps/web) -> `npm run db:seed -- --reset` -> `npm run typecheck` -> `npm test` -> `npm run build` -> build `Dockerfile.aws` and curl `/` and `/admin` from the running container with fake env.

`npm run build` is there because turbo's `dependsOn: ["^build"]` never builds the package itself; without it, bundle breaks only show at deploy (#148). The tutor eval and the infra `*.test.sh` scripts are NOT run in CI.

**release.yml** (tag `v*` or workflow_dispatch; production job only for tag refs; concurrency `production-release`, never cancelled):
- `test`: same DB init/typecheck/test/build, then builds a linux/amd64 image labeled with the SHA, smoke-tests it (`migrate.ts`, both SPA index files, `tsx`, `pg`, `okf --version`), saves it as a checksummed artifact.
- `production` (environment `production`, OIDC): validate target/role/SHA -> build infra -> validate the nine production secrets -> assume deploy role, verify account and caller ARN -> load the exact tested image (checksum, image ID, revision label) -> `config refresh` (skipped for a stack with no history) -> bootstrap base infra if ECR absent -> push image, verify digest matches artifact -> register candidate task def while keeping current service -> `run-aws-migrations.sh` runs migrations as a one-off task with the candidate -> pin `serviceTaskDefinition`, `pulumi up`, wait stable -> verify `/api/health` version equals the SHA -> write a rollback reference to the step summary.

Invariant: migrations complete before the service moves; a failed migration stops activation. App rollback does not reverse schema.

# Related Concepts
- [DB-backed tests silently skip without DATABASE_URL](../facts/code-db-tests-skip-without-database-url.md): What CI's Postgres service enables that local runs skip
- [Review process: 11-dimension audits, findings filed as issues, live-DB verification](../facts/eleven-dimension-review-process.md): The review process around PRs
