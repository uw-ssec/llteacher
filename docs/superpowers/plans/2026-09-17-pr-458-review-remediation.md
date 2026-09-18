# PR 458 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every finding in the PR #458 eleven-dimension review or attach a verified technical rationale where changing the implementation would be incorrect.

**Architecture:** Harden the shared Pulumi program for real AWS while preserving Floci's local compatibility, make the Node runtime derive security-sensitive values from explicit configuration, and extract deployment shell behavior into testable scripts. Add resource-level Pulumi mocks, behavior-based shell tests, runtime regression tests, and current operational documentation.

**Tech Stack:** TypeScript, Pulumi AWS, ECS/Fargate, RDS PostgreSQL, Route 53/ACM, Hono Node server, Bash, GitHub Actions, Vitest, Docker/Buildx.

**Spec:** https://github.com/uw-ssec/llteacher/pull/458#issuecomment-5722127788

## Global Constraints

- Preserve the local Floci resource state; do not destroy or reset `.floci/`, `.pulumi/`, Docker volumes, or the local stack.
- Never print Pulumi passphrases, database credentials, or runtime secrets.
- Keep migration-before-service ordering in every deployment path.
- Staging and production must use private application/database subnets, validated ACM certificates, protected RDS, and least-privilege IAM.
- Local deployment may retain Floci-specific public-subnet behavior where the emulator cannot model NAT/private routing.
- Every code fix follows a failing-test, minimal-fix, passing-test cycle.

---

### Task 1: Critical Pulumi security and persistence

**Files:**
- Modify: `infra/src/config.ts`
- Modify: `infra/src/network.ts`
- Modify: `infra/src/database.ts`
- Modify: `infra/src/app.ts`
- Modify: `infra/src/scheduled-job.ts`
- Modify: `infra/src/index.ts`
- Modify: `infra/Pulumi.staging.yaml`
- Modify: `infra/Pulumi.production.yaml`
- Create: `infra/src/resources.test.ts`

**Interfaces:**
- Produces: `InfraConfig.hostedZoneId?: string`, `Network.appSubnetIds`, `Network.databaseSubnetIds`, `Application.service?`, and Pulumi outputs for migration task networking.
- Consumes: existing `Environment`, `Database`, and `Application` resource interfaces.

- [ ] **Step 1: Write failing Pulumi mock tests**

Use `pulumi.runtime.setMocks` to record resource inputs and assert: production requires `hostedZoneId`; Route 53 validation records and `aws:acm/certificateValidation:CertificateValidation` exist; `iam:PassRole` names only the ECS execution/task roles; RDS has `backupRetentionPeriod: 7`, `deletionProtection: true`, `skipFinalSnapshot: false`, and Pulumi `protect`; the production DB/app use private subnets; ECS service has `healthCheckGracePeriodSeconds` and depends on the listener; the scheduled target has an SQS DLQ and retry policy.

- [ ] **Step 2: Run the new test and verify failure**

Run: `npm test --workspace=infra -- resources.test.ts`

Expected: FAIL because the production-only resources and safeguards are absent.

- [ ] **Step 3: Implement the critical resource changes**

Require a Route 53 hosted zone ID for non-local stacks, create DNS validation records from `certificate.domainValidationOptions`, pass `certificateValidation.certificateArn` to the listener, and retain Floci's direct certificate path locally. Create public ALB subnets plus private app/database subnets and a NAT route in non-local environments. Scope `iam:PassRole` to `app.executionRole.arn` and the application task role ARN. Protect production RDS with seven-day backups, deletion protection, a final snapshot identifier, and Pulumi `protect`. Add ECS listener dependency, a health-check grace period, an SQS DLQ, EventBridge retries, and a CloudWatch alarm for visible DLQ messages.

- [ ] **Step 4: Run infra tests and typecheck**

Run: `npm test --workspace=infra && npm run typecheck --workspace=infra`

Expected: all infra tests pass and TypeScript exits zero.

### Task 2: Runtime origin, secrets, database singleton, and shutdown safety

**Files:**
- Modify: `apps/web/src/shared/types.ts`
- Modify: `apps/web/src/runtime/config.ts`
- Modify: `apps/web/src/runtime/config.test.ts`
- Modify: `apps/web/src/db/client.ts`
- Modify: `apps/web/src/db/client.test.ts`
- Modify: `apps/web/src/node/server.ts`
- Modify: `apps/web/src/node/server.test.ts`
- Modify: `apps/web/src/server/routes/auth.ts`
- Modify: `apps/web/src/server/routes/auth.test.ts`
- Modify: `infra/src/app.ts`

**Interfaces:**
- Produces: required `APP_URL` runtime binding and `closeNodeServer(server, timeoutMs)` bounded shutdown.
- Consumes: Pulumi `domainName` to set ECS `APP_URL`.

- [ ] **Step 1: Write failing runtime security tests**

Assert startup rejects each missing required secret; hostile `X-Forwarded-Host` cannot change OAuth callback/logout origins; `makeDb` rejects a second different URL until `closeDb`; and shutdown force-closes connections after a 25-second bound before releasing the pool.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test --workspace=apps/web -- src/runtime/config.test.ts src/db/client.test.ts src/node/server.test.ts src/server/routes/auth.test.ts`

Expected: FAIL on missing-secret, forwarded-host, URL mismatch, and timeout assertions.

- [ ] **Step 3: Implement explicit trusted runtime configuration**

Add required `APP_URL`, validate it as an `http:` or `https:` origin with no path/query/hash, require all ECS-injected secrets, and use `APP_URL` for callback URLs, secure-cookie policy, and logout return URLs. Stop reading `X-Forwarded-Host`; only use the configured public origin. Track the singleton pool URL and throw on mismatches. Bound graceful shutdown and call `closeAllConnections()` when the deadline expires.

- [ ] **Step 4: Run focused tests and web typecheck**

Run: `npm test --workspace=apps/web -- src/runtime/config.test.ts src/db/client.test.ts src/node/server.test.ts src/server/routes/auth.test.ts && npm run typecheck --workspace=apps/web`

Expected: focused tests and typecheck pass.

### Task 3: Remove Workers-only job limits and cover CLI lifecycles

**Files:**
- Modify: `apps/web/src/server/jobs/autoSubmitOverdue.ts`
- Modify: `apps/web/src/server/jobs/autoSubmitOverdue.test.ts`
- Modify: `apps/web/src/server/jobs/autoSubmitOverdue.db.test.ts`
- Modify: `apps/web/src/node/run-overdue-job.ts`
- Modify: `apps/web/src/node/run-overdue-job.test.ts`
- Modify: `apps/web/src/node/server.test.ts`

**Interfaces:**
- Produces: a Node/ECS sweep that processes every organization while retaining fixed query-result bounds and per-candidate error isolation.
- Consumes: existing batch query and per-org candidate caps.

- [ ] **Step 1: Replace budget expectations with full-run expectations**

Write tests proving more than 900 candidate operations complete in one ECS run, `orgsDeferred` remains zero, fixed batch query caps remain enforced, the overdue CLI sets failure status on rejection, and SIGINT/SIGTERM invoke the bounded server shutdown once.

- [ ] **Step 2: Run focused job/entrypoint tests and verify failure**

Run: `npm test --workspace=apps/web -- src/server/jobs/autoSubmitOverdue.test.ts src/node/run-overdue-job.test.ts src/node/server.test.ts`

Expected: FAIL while the Workers subrequest budget and untested entrypoint wrappers remain.

- [ ] **Step 3: Remove the Cloudflare budget path**

Delete `AUTO_SUBMIT_RUN_SUBREQUEST_BUDGET` accounting and stale neon/Worker comments, process all batches, preserve batch-size/query-payload caps, and expose small injectable CLI lifecycle functions so exit and signal behavior can be tested without spawning processes.

- [ ] **Step 4: Run focused and database-backed tests**

Run: `npm test --workspace=apps/web -- src/server/jobs/autoSubmitOverdue.test.ts src/node/run-overdue-job.test.ts src/node/server.test.ts`

Expected: all focused tests pass; database-gated cases remain gated when `DATABASE_URL` is absent.

### Task 4: Production migration runner and release guardrails

**Files:**
- Create: `infra/scripts/run-aws-migrations.sh`
- Create: `infra/scripts/run-aws-migrations.test.sh`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Produces: `run-aws-migrations.sh <stack>` with six bounded attempts, diagnostics, log-tail capture, and Pulumi-output network discovery.
- Consumes: Pulumi outputs `appSubnetIds` and `appSecurityGroupId`.

- [ ] **Step 1: Write a fake-AWS regression test**

Use temporary fake `aws` and `pulumi` binaries to assert transient failures retry, final failures print stopped reasons and CloudWatch logs, network configuration does not depend on an existing ECS service, and success exits immediately.

- [ ] **Step 2: Run the shell test and verify failure**

Run: `bash infra/scripts/run-aws-migrations.test.sh`

Expected: FAIL because the production migration script does not exist.

- [ ] **Step 3: Implement and wire the production migration runner**

Create the script with bounded retries/backoff and diagnostics. Add a release job guard allowing staging only from `refs/heads/staging` and production only from tags. Replace inline migration code with the script. Add Buildx GHA cache scopes shared by the test and release image builds.

- [ ] **Step 4: Run shell tests and validate workflow syntax**

Run: `bash infra/scripts/run-aws-migrations.test.sh && ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release.yml")'`

Expected: shell behavior passes and YAML parses.

### Task 5: Local script bounds and behavior-based tests

**Files:**
- Modify: `infra/scripts/floci-up.sh`
- Modify: `infra/scripts/run-local-migrations.sh`
- Modify: `infra/scripts/local-test.test.sh`
- Modify: `infra/scripts/tls-proxy-up.test.sh`
- Create: `infra/scripts/floci-up.test.sh`

**Interfaces:**
- Produces: bounded Floci readiness with actionable container diagnostics.
- Consumes: existing `LLTEACHER_LOCAL_*` environment controls.

- [ ] **Step 1: Write failing fake-binary tests**

Assert Floci readiness stops after a configurable attempt count and prints `docker ps`/logs; TLS startup supplies the host gateway and mounted files; local-test passes the repository certificate; migration AWS arrays preserve each argument exactly.

- [ ] **Step 2: Run shell tests and verify failure**

Run: `bash infra/scripts/floci-up.test.sh && bash infra/scripts/local-test.test.sh && bash infra/scripts/tls-proxy-up.test.sh`

Expected: FAIL against the unbounded/pattern-only implementations.

- [ ] **Step 3: Implement bounded loops and safe array expansion**

Add `FLOCI_HEALTH_ATTEMPTS` and `FLOCI_HEALTH_DELAY_SECONDS`, emit diagnostics after exhaustion, and quote every `"${aws_local[@]}"` expansion. Replace grep-only assertions with fake process behavior.

- [ ] **Step 4: Run every infra shell test**

Run: `for test in infra/scripts/*.test.sh; do bash "$test"; done`

Expected: every script exits zero.

### Task 6: Provider abstraction, dependency reproducibility, and CI image caching

**Files:**
- Modify: `infra/src/provider.ts`
- Modify: `infra/src/app.ts`
- Modify: `infra/package.json`
- Modify: `package-lock.json`
- Modify: `Dockerfile.aws`
- Modify: `infra/scripts/tls-proxy-up.sh`
- Modify: `.github/workflows/local-aws.yml`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Produces: provider/config-owned image URI selection and reproducible dependency/container inputs.

- [ ] **Step 1: Add assertions for image selection and pinned inputs**

Extend infra tests to assert local canonical-ECR and production repository URI behavior. Add shell assertions rejecting caret Pulumi ranges and unpinned base/runtime images.

- [ ] **Step 2: Run assertions and verify failure**

Run: `npm test --workspace=infra && bash infra/scripts/tls-proxy-up.test.sh`

Expected: FAIL on current caret ranges and floating image tags.

- [ ] **Step 3: Centralize and pin**

Move image URI selection behind a focused provider/config helper, pin Pulumi packages exactly, pin Node and Caddy images by immutable digest, update the lockfile, and use Buildx cache import/export with a shared `llteacher-aws` scope.

- [ ] **Step 4: Rebuild and test**

Run: `npm install && npm run build --workspace=infra && npm test --workspace=infra`

Expected: lockfile is stable and infra build/tests pass.

### Task 7: Documentation and repository metadata cleanup

**Files:**
- Rewrite: `docs/architecture/dev-api-proxy.md`
- Modify: `turbo.json`
- Move: `docs/plan/*.md` to `docs/superpowers/plans/`
- Modify: `infra/README.md`

**Interfaces:**
- Produces: current Node/Vite development documentation and one discoverable planning-doc location.

- [ ] **Step 1: Add repository checks**

Use `rg` assertions to prove docs contain no `devApiProxy`, `.dev.vars`, Worker asset binding, `.wrangler`, or deleted `wrangler.jsonc` build metadata, and that `docs/plan/` no longer exists.

- [ ] **Step 2: Run checks and verify failure**

Run: `! rg -n 'devApiProxy|\.dev\.vars|ASSETS binding|\.wrangler|wrangler\.jsonc' docs/architecture/dev-api-proxy.md turbo.json`

Expected: FAIL because stale Workers-era content exists.

- [ ] **Step 3: Update documentation and metadata**

Document Vite's Node server/proxy behavior and `.env` flow, remove Wrangler cache inputs/outputs, move M12 plan files into the established directory, and document hosted-zone/private-network/RDS-protection requirements.

- [ ] **Step 4: Verify the cleanup**

Run: `! rg -n 'devApiProxy|\.dev\.vars|ASSETS binding|\.wrangler|wrangler\.jsonc' docs/architecture/dev-api-proxy.md turbo.json && test ! -d docs/plan && git diff --check`

Expected: all checks exit zero.

### Task 8: Full verification and review response

**Files:**
- Modify: PR #458 review conversation via GitHub API.

**Interfaces:**
- Produces: one review reply mapping all 26 findings to commits/files/tests or a verified rationale.

- [ ] **Step 1: Run the complete verification matrix**

Run: `npm run typecheck && npm test && for test in infra/scripts/*.test.sh; do bash "$test"; done && LLTEACHER_LOCAL_CA=.floci/certs/llteacher.local.pem npm run aws:local:verify && git diff --check`

Expected: every command exits zero.

- [ ] **Step 2: Commit and push the remediation**

Run: `git add -A && git commit -m "fix(infra): address deployment review findings" && git push origin ksdani/m12-infra`

Expected: the remote branch advances without force-push.

- [ ] **Step 3: Wait for all PR checks**

Run: `gh pr checks 458 --repo uw-ssec/llteacher --watch --interval 10`

Expected: every required check concludes successfully.

- [ ] **Step 4: Reply to the review comment**

Post a structured response under issue comment `5722127788` listing each finding, its resolution, and verification evidence. For any non-change, state the exact code path and test proving why the recommendation does not apply.
