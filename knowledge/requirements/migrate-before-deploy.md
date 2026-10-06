---
type: Requirement
title: Database migrations must finish before new application code serves traffic
description: Every deploy path runs Drizzle migrations to completion (and validates concurrent indexes) before the new task/bundle is activated; migration failure blocks activation. Rollback of code after a forward migration must stay safe.
tags: [migrations, deploy, database, reliability]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [.github/workflows/release.yml, apps/web/ARCHITECTURE.md, apps/web/drizzle.config.ts, apps/web/scripts/migrate.ts, apps/web/src/db/migrations, infra/scripts/run-aws-migrations.sh, infra/scripts/run-local-migrations.sh]
sources:
  - resource: apps/web/ARCHITECTURE.md
  - resource: docs/superpowers/plans/2026-09-15-m12-local-aws-design.md
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md
  - resource: commit 368d495
  - resource: commit f245d49
  - resource: "issue #179"
  - resource: "PR #458"
  - resource: "PR #461"
  - resource: "PR #467"
  - resource: "issue #244"
  - resource: apps/web/README.md
  - resource: .github/workflows/release.yml
  - resource: eae7f24
---

## The requirement
**Migrate before deploy, always** (#284). Drizzle's schema is shared between the query builder and the migrator. New code selecting a column the database does not yet have fails every request: `42703 column messages.seq does not exist` on `POST /api/chat`. Before #276 that showed up as a student's history silently vanishing.

## Where it is enforced
- **AWS release:** the candidate task definition runs `run-aws-migrations.sh production <candidate-arn>` as a one-off ECS task. Activation happens only after it succeeds. A second migrator is never launched after an uncertain timeout.
- **Local Floci:** `aws:local:up` runs migrations before the service starts (commit `13f9497`), with a migration guard script.
- **CI:** `test.yml` runs `db:migrate` against a real `pgvector/pgvector:pg16` service before tests.
- **Concurrent indexes:** invalid `CREATE INDEX CONCURRENTLY` leftovers are detected and recovered before deploy. Concurrent-index statements are preflighted for replay safety (commits `368d495`, `f245d49`), so a failed build cannot pass on the next release.

## Rules for migration authors
- Migrations are additive and forward-only, and safe to run twice (M2 constraint).
- Generate SQL with `npm run db:generate` (drizzle-kit). Do not hand-write it (M3 constraint).
- Keep code rollback safe. Old code must work against the new schema: new columns are nullable or have defaults, as `seq` (nextval) and `client_message_id` (nullable) do.
- A constraint migration that would destroy data must fail and stop the deploy, not delete rows. The submission-uniqueness migration deliberately fails if duplicates exist.
- Turbo strips undeclared environment variables. `turbo.json`'s `test` task must declare `DATABASE_URL`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY`, or the real-database tests silently skip (M2 decision 11).

## Doc drift
`apps/web/ARCHITECTURE.md` "Deploy Order" still talks about `wrangler deploy` and `npm run deploy`. Those are retired. The rule stands and the mechanism is now the ECS migration task.

## From the issue tracker and reviews

## Why ordering matters more than it looks (#179)

`rolesMiddleware` runs `listMembershipsForUser` on **every authenticated request**. Drizzle emits the column list from the compiled schema, so an app deployed before its migration fails that query with `column ... does not exist`. `app.onError` turns that into a 503 for every API call and every user. An additive schema change can take down the whole product.

## Current mechanism (PRs #458, #461)

- The tagged release (`v*` and the protected `production` environment, via OIDC) builds and tests **one image artifact**.
- It **registers a candidate task definition** while the live ECS service stays pinned to the old one.
- It runs **that exact candidate's migrations** as a one-off Fargate task (`run-aws-migrations.sh`) and activates the service only if they succeed. Retries happen only on terminal failure.
- The first-deploy migration task reads Pulumi subnet and security-group outputs rather than an ECS service that may not exist yet.
- Rollback references are recorded. **Rolling back application code does not reverse schema changes**, so migrations must stay backward compatible with the previous app version for at least one release.
- PR #467: changes to managed secret versions also rotate the candidate task definition, keeping the service pinned until activation.

## Release-one constraints (PR #461)

There is a single ECS task with stop-before-start deployment, HTTPS is mandatory for production activation, and overdue-job scheduling runs in process. NAT, worker and scheduled-task resources were removed to keep the stack minimal.

## Guidance

- Write expand-then-contract migrations. Never drop or rename a column that the currently live version reads.
- Large-table index builds lock writes (#244). Prefer online builds and the invalid-index recovery in `migrate.ts`.

## From the issue tracker and reviews

Drizzle's schema object is shared by the query builder and the migrator, so any migration that adds a column read via `db.select().from(...)` makes the new app's queries reference a column the old database lacks. Deploying code first turned every `POST /api/chat` into `42703 column messages.seq does not exist` -> 500 (#284). Before #276 the client failed open and showed an empty transcript, which looked to students like lost history rather than an outage.

**Order, always:** build and publish image -> run `npm run db:migrate` as a one-off task with the NEW image and production env -> confirm success -> move the service. A failed migration must stop activation.

**How the pipeline enforces it:**
- `release.yml`: registers a candidate task definition while the current service keeps running, runs `infra/scripts/run-aws-migrations.sh production <candidate-arn>` (an ECS one-off task in the app subnets, up to 6 attempts, 600s wait, reports stopped reason and log stream on failure), and only then pins `serviceTaskDefinition` and runs `pulumi up`.
- Local Floci: `infra/scripts/local-up.sh` deploys with `deployApp false`, runs `run-local-migrations.sh`, then sets `deployApp true`. `run-local-migrations.test.sh` (`npm run aws:local:migration-guard`) asserts "migration failure prevented service update".
- The image must contain the runner: Dockerfile.aws copies `apps/web/scripts/migrate.ts`, and `tsx` and `pg` are runtime `dependencies` (not devDependencies) for this reason; the release smoke test checks all three.

**Rollback direction:** rolling app code back after a forward migration is safe when new columns are nullable or defaulted (e.g. `seq` has a `nextval` default, `client_message_id` is nullable). Schema changes are never reversed by an app rollback, and selecting an older task definition does not restore older secret values. Design migrations so the previous release still works against the new schema.

apps/web/ARCHITECTURE.md's "Deploy Order" section still mentions `npm run deploy`/`wrangler deploy`; those are Workers-era. The rule is unchanged.

# Related Concepts
- [scripts/migrate.ts: two-stage apply and CONCURRENTLY handling](../facts/code-migrate-runner-split-and-concurrently.md): The runner that applies migrations
- [Drizzle migration numbering: PR-open order wins, CI checks collisions](../facts/migration-index-collision-convention.md): Numbering rules for the migrations being applied
