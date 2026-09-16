# M12 Deployment and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide safe local deployment commands and CI verification that enforce migrate-before-deploy.

**Architecture:** Root scripts orchestrate Floci, Pulumi, image publishing, one-off migration execution, ECS update, and health checks. CI runs the disposable local path; future real-AWS release workflows select staging or production explicitly.

**Tech Stack:** npm workspaces, Docker, Pulumi, Floci, GitHub Actions, Vitest.

**Spec:** `docs/plan/2026-09-15-m12-local-aws-design.md`

## Global Constraints

- Never log secrets.
- Migration failure prevents an ECS service update.
- Local teardown cannot affect an AWS stack.

---

### Task 1: Local command surface

**Files:** modify root `package.json`; create `infra/scripts/local-up.sh`, `infra/scripts/local-test.sh`, `infra/scripts/local-down.sh`, `infra/scripts/deploy-local.sh`, and `infra/scripts/deploy-local.test.sh`.

- [x] Write a failing shell test that simulates a migration failure and asserts the ECS update command is not called.
- [x] Implement `aws:local:up`, `aws:local:test`, and `aws:local:down`; require an explicit `local` stack and order build/push → migration task → service update → HTTPS health checks.
- [x] Use the existing deterministic test provider for streamed chat and assert SSE chunks arrive in integration coverage.
- [x] Run `npm run aws:local:test`; the durable developer stack is retained across normal up/down cycles by design.
- [x] Commit: `feat(deploy): add safe local AWS commands`.

### Task 2: CI and production workflow scaffolding

**Files:** modify `.github/workflows/test.yml`; create `.github/workflows/local-aws.yml` and `.github/workflows/release.yml`; modify `README.md`, `apps/web/README.md`, and `infra/README.md`.

- [x] Write a workflow assertion that the local-AWS job starts Floci and calls `npm run aws:local:test` without AWS credentials.
- [x] Remove Wrangler dry-run assumptions; run workspace typecheck/build/tests and the Floci/Pulumi integration path on pull requests.
- [x] Add a protected manual release workflow skeleton that uses GitHub OIDC and chooses `staging` or `production`; it must run preview, migration, service update, and health checks in that order.
- [x] Document copyable local prerequisites and the three local commands in the root README.
- [x] Commit: `ci: verify local AWS deployment path`.
