---
type: Decision
title: "Releases deploy to AWS only from version tags, and migrations run before the new task is activated"
description: "release.yml builds and tests one image, then on a v* tag in the protected production environment uses OIDC, publishes that exact image, registers a candidate, runs a one-off migration, and activates only on success."
tags: [ci, release, deploy, migrations]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: constraint
code_refs: [.github/workflows/release.yml, .github/workflows/test.yml, infra/scripts/run-aws-migrations.sh, infra/scripts/prepare-aws-release.sh, infra/scripts/aws-release-common.sh, infra/scripts/release-workflow.test.mjs]
sources:
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: docs/superpowers/plans/2026-09-15-m12-deploy-ci-implementation.md
  - resource: infra/README.md
  - resource: commit 48404e1
  - resource: commit 2b8ad3d
  - resource: commit 04cdda0
---

## Spec proposed
The M12 deploy/CI plan (2026-09-15) added a `local-aws.yml` that ran Floci on pull requests, plus a manual release skeleton that picked either `staging` or `production`. An auto-deploy on push to `staging` existed in that era. The 2026-09-21 design narrowed this to one protected, tag-triggered production release with a 12-step order: test, OIDC, ECR bootstrap, publish, preview, candidate, migrate, stop on failure, activate, check health/version, keep the rollback digest.

## Implemented
`.github/workflows/release.yml` triggers on `tags: ["v*"]`. The `production` job runs in the GitHub `production` environment and requires `github.ref_type == 'tag'`. Each release:
1. Loads the test job's checksum-checked image artifact and publishes *that* image. It does not rebuild (commit `2b8ad3d`).
2. Checks the stack's region, environment, domain, and certificate before the first mutation (commit `04cdda0`).
3. Registers a candidate task definition while the service stays pinned to the current one.
4. Runs `run-aws-migrations.sh production <candidate-arn>` as a one-off ECS task. Only confirmed terminal failures are retried, and a second migrator never launches after an uncertain timeout.
5. Activates the candidate, waits for stability, and checks that `/api/health` reports the expected commit.

Releases are serialized by a concurrency group. `local-aws.yml` was removed, and `test.yml` is ordinary CI with a disposable pgvector Postgres service.

## Why
- Migrate-before-deploy is a hard requirement (see `requirements/migrate-before-deploy`).
- Shipping the exact tested artifact prevents build drift.
- No long-lived AWS keys are used.

## Rejected alternatives
- Branch-push auto-deploy to staging. It was removed, and adding another environment needs a separately reviewed release design.
- Floci in CI.
- Rebuilding the image in the deploy job.

## Consequences
- Production activation needs `domainReady=true` and an issued, operator-owned ACM certificate. Domainless mode is limited to base-infrastructure bootstrap with `deployApp=false`.
- Real AWS apply has needed explicit owner approval at each stage. As of October 2026, PRs #469-#473 were still hardening the bootstrap.

# Related Concepts
- [CI and release pipeline](../architecture/ci-release-pipeline.md): The workflows as implemented
- [Database migrations must finish before new application code serves traffic](../requirements/migrate-before-deploy.md): Candidate migrations run before activation
- [Release logs hid Pulumi errors via /dev/null and command substitution](../bugs/pulumi-bootstrap-errors-swallowed.md): Release-log bug fixed on the way to the first deploy
- [First AWS production release blockers: new stack refresh and missing service-linked roles](../bugs/first-production-release-blockers.md): Blockers hit by the first tagged release
- [Grader-tier routes must declare a release-gate posture](../facts/code-release-gate-posture-test.md): A test that guards release posture of grader routes
