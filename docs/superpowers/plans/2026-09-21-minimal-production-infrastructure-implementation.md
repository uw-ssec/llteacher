# Minimal Production Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace the current oversized/divergent infrastructure with one minimal ECS/Fargate application stack in us-west-2, validate it locally through Floci, and provide an AWS-only GitHub release workflow that builds, tests, migrates, and deploys without exposing application secrets to GitHub.

**Architecture:** One Pulumi program creates the same application topology in Floci and AWS: public ALB and Fargate task, private RDS PostgreSQL, private S3 materials storage, two Secrets Manager secrets, ECR, IAM, Route 53, ACM, and CloudWatch Logs. Floci is invoked only by developer-local scripts. GitHub Actions authenticates to real AWS through OIDC, pushes one immutable image to ECR, runs migrations as an ECS task, and then updates the service.

**Tech Stack:** Pulumi TypeScript, AWS ECS/Fargate, RDS PostgreSQL 16/pgvector, S3, Secrets Manager, ECR, ALB, Route 53, ACM, GitHub Actions/OIDC, Floci 2.1.0, Vitest, Bash, Docker Buildx.

**Spec:** docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md

## Global Constraints

- All regional local and AWS resources use us-west-2; Route 53 and IAM remain global.
- Do not create NAT, CloudFront, SQS, EventBridge, or a separate worker/scheduled ECS task.
- Course extraction remains in-process; interrupted work becomes visible and retryable.
- The application stack uses the same Pulumi resource types in Floci and AWS.
- Floci runs only through developer-local commands. No GitHub Actions workflow starts Floci.
- The AWS release runs install, typecheck, tests, build, publish, Pulumi, migrations, service update, and smoke verification in that order.
- Runtime secrets are injected from Secrets Manager and are not GitHub secrets.
- GitHub stores PULUMI_ACCESS_TOKEN as its only secret while Pulumi Cloud is the backend. AWS_DEPLOY_ROLE_ARN is an environment variable; AWS credentials come from OIDC.
- Do not run a production pulumi up without the release owner's later explicit approval.
- Preserve unrelated changes and never prune unrelated Docker state.

## Review Focus

- Unapproved refs must stop before AWS mutation; Task 7 tests release guards.
- Rotated secrets must reach replacement ECS tasks without appearing in logs; Tasks 3 and 7 test this.
- First release must bootstrap ECR before image push; Task 7 tests two-phase order.
- Public-IP Fargate must accept traffic only from the ALB and RDS must remain private; Task 2 tests this.
- Repeated local deploys must not accumulate timestamp tags or delete unrelated images; Task 6 tests this.

---

### Task 1: Region-aware configuration

**Files:**
- Modify: infra/src/config.ts
- Modify: infra/src/config.test.ts
- Modify: infra/src/provider.ts
- Modify: infra/Pulumi.local.example.yaml
- Modify: infra/Pulumi.staging.yaml
- Modify: infra/Pulumi.production.yaml
- Modify: infra/scripts/run-local-migrations.sh

**Interfaces:**
- Produces: InfraConfig.region: string
- Produces: loadInfraConfig(appConfig?: ConfigReader, awsConfig?: ConfigReader): InfraConfig
- Tasks 2–3 consume config.region.

- [ ] **Step 1: Write failing region tests**

Add tests that load aws:region us-west-2, reject us-east-1, and expect the local canonical image to be:

    000000000000.dkr.ecr.us-west-2.amazonaws.com/llteacher-local/app:sha-123

- [ ] **Step 2: Run the focused tests**

Run: npm test --workspace=infra -- --run src/config.test.ts

Expected: FAIL because region is absent and provider/image values are hard-coded.

- [ ] **Step 3: Implement the region contract**

Read the AWS config separately, require us-west-2, pass it into both providers, and construct canonical ECR names from config.region. Set every committed Pulumi stack to aws:region: us-west-2 and change the migration-script fallback.

- [ ] **Step 4: Verify the region boundary**

Run:

    npm test --workspace=infra -- --run src/config.test.ts
    npm run typecheck --workspace=infra
    ! rg -n 'us-east-1' infra/src infra/scripts .github/workflows/release.yml infra/Pulumi.*.yaml

Expected: PASS.

- [ ] **Step 5: Commit**

    git add infra/src/config.ts infra/src/config.test.ts infra/src/provider.ts infra/Pulumi.local.example.yaml infra/Pulumi.staging.yaml infra/Pulumi.production.yaml infra/scripts/run-local-migrations.sh
    git commit -m "fix(infra): standardize stacks on us-west-2"

### Task 2: Minimal network, Route 53, and exact graph

**Files:**
- Modify: infra/src/network.ts
- Modify: infra/src/app.ts
- Create: infra/src/dns.ts
- Modify: infra/src/index.ts
- Modify: infra/src/resources.test.ts
- Modify: infra/src/config.ts
- Modify: infra/src/config.test.ts
- Modify: infra/Pulumi.local.example.yaml
- Modify: infra/Pulumi.staging.yaml
- Modify: infra/Pulumi.production.yaml

**Interfaces:**
- Produces: DnsResources with hostedZone, certificateArn, and appRecord.
- Produces: appSubnetIds equal to public subnet IDs.
- Preserves: databaseSubnetIds equal to private subnet IDs.

- [ ] **Step 1: Write failing graph tests**

Record local and production graphs. Assert zero NAT/EIP/EventBridge/SQS/CloudFront resources. Assert ECS uses the two public subnets with assignPublicIp true, RDS uses two private subnets with publiclyAccessible false, application ingress references only the ALB group, and database ingress references only the application group.

Assert a Route 53 hosted zone, ACM validation record, CertificateValidation, HTTPS listener, and A alias to the ALB. Compare sorted local/production application resource-type lists for equality.

- [ ] **Step 2: Run graph tests**

Run: npm test --workspace=infra -- --run src/resources.test.ts

Expected: FAIL on the current NAT, private application placement, missing hosted zone/alias, and scheduler resources.

- [ ] **Step 3: Implement minimal networking**

Derive us-west-2a/b from config.region. Keep two public and two private DB subnets. Return public IDs for appSubnetIds. Remove EIP, NAT, private application routes/associations. Set assignPublicIp true in all environments.

- [ ] **Step 4: Create the DNS module**

Create:

    interface DnsResources {
      appRecord: aws.route53.Record;
      certificateArn: pulumi.Output<string>;
      hostedZone: aws.route53.Zone;
    }

createDnsResources always creates the zone for domainName, certificate, DNS validation, and ALB alias. Remove hostedZoneId input because the stack owns the zone.

- [ ] **Step 5: Remove scheduled infrastructure composition**

Remove createOverdueJob and scheduled log outputs from infra/src/index.ts. Task 4 deletes the module after replacing behavior.

- [ ] **Step 6: Verify and commit**

Run:

    npm test --workspace=infra -- --run src/config.test.ts src/resources.test.ts
    npm run typecheck --workspace=infra
    npm run build --workspace=infra

Commit:

    git add infra/src
    git add infra/Pulumi.local.example.yaml infra/Pulumi.staging.yaml infra/Pulumi.production.yaml
    git commit -m "refactor(infra): minimize the fargate resource graph"

### Task 3: Secrets injection and protected S3 storage

**Files:**
- Modify: infra/src/app.ts
- Modify: infra/src/database.ts
- Modify: infra/src/resources.test.ts
- Modify: apps/web/src/runtime/config.ts
- Modify: apps/web/src/runtime/config.test.ts
- Modify: infra/README.md

**Interfaces:**
- Produces: execution-role policy scoped to two secret ARNs.
- Produces: ECS secret mappings for required process.env keys.
- Produces: normal APP_URL, AWS_REGION, and STORAGE_BUCKET environment values.

- [ ] **Step 1: Write failing resource tests**

Parse the execution policy and assert Action equals secretsmanager:GetSecretValue and Resource contains only database-url and runtime secret ARNs.

Parse the container definition and assert DATABASE_URL, WORKOS_API_KEY, WORKOS_CLIENT_ID, WORKOS_WEBHOOK_SECRET, provider keys, and cryptographic keys are under secrets. Assert APP_URL, AWS_REGION, and STORAGE_BUCKET are under environment.

Assert S3 public blocking, encryption, enabled versioning, noncurrent-version lifecycle, and Pulumi protection outside local.

- [ ] **Step 2: Confirm failures**

Run: npm test --workspace=infra -- --run src/resources.test.ts

Expected: FAIL because execution-role secret permission, storage environment, and S3 protections are missing.

- [ ] **Step 3: Implement scoped ECS secret retrieval**

Add one inline execution-role policy using both exact secret ARNs. Keep S3 access on the task role. Never use Resource "*".

- [ ] **Step 4: Complete runtime configuration**

Inject the bucket name and region as normal values. Add STORAGE_ENDPOINT only in local Floci; omit production storage credentials so the SDK uses the ECS task role.

- [ ] **Step 5: Add S3 safeguards**

Enable server-side encryption, versioning, a documented noncurrent-version lifecycle, public-access blocking, forceDestroy false, and Pulumi protect outside local.

- [ ] **Step 6: Document credentials**

Document one-time encrypted Pulumi config entry, AWS secret JSON keys, task restart after rotation, and WorkOS callback https://<domain>/api/auth/callback.

Document:

    GitHub secret: PULUMI_ACCESS_TOKEN
    GitHub variable: AWS_DEPLOY_ROLE_ARN
    Not in GitHub: DATABASE_URL and all WorkOS/provider/application secrets

- [ ] **Step 7: Verify and commit**

Run:

    npm test --workspace=infra -- --run src/resources.test.ts
    npm test --workspace=llteacher-web -- --run src/runtime/config.test.ts
    npm run typecheck --workspace=infra
    npm run typecheck --workspace=llteacher-web

Commit:

    git add infra/src/app.ts infra/src/database.ts infra/src/resources.test.ts apps/web/src/runtime/config.ts apps/web/src/runtime/config.test.ts infra/README.md
    git commit -m "fix(infra): inject scoped runtime secrets into ecs"

### Task 4: In-process overdue scheduler

**Files:**
- Create: apps/web/src/node/overdue-scheduler.ts
- Create: apps/web/src/node/overdue-scheduler.test.ts
- Modify: apps/web/src/db/client.ts
- Modify: apps/web/src/db/client.test.ts
- Modify: apps/web/src/node/server.ts
- Modify: apps/web/src/node/server.test.ts
- Delete: infra/src/scheduled-job.ts
- Modify: infra/src/resources.test.ts
- Modify: apps/web/README.md

**Interfaces:**
- Produces: withSessionAdvisoryLock<T>(key, work): Promise<{ acquired: boolean; value?: T }>
- Produces: startOverdueScheduler(options): { stop(): void }

- [ ] **Step 1: Write advisory-lock tests**

With a fake PoolClient, assert connect → pg_try_advisory_lock → work → pg_advisory_unlock → release. Add contention and thrown-work cases; work must not run on contention, and unlock/release must run after errors.

- [ ] **Step 2: Run the failing test**

Run: npm test --workspace=llteacher-web -- --run src/db/client.test.ts

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement a same-session lock**

Acquire and release on one checked-out PoolClient using parameterized queries. Do not unlock through another pooled connection.

- [ ] **Step 4: Write scheduler lifecycle tests**

With fake timers, assert one startup run, one run after 3,600,000 ms, no overlapping runs, failure logging without process exit, and no calls after stop().

- [ ] **Step 5: Integrate the scheduler**

Start after config/DB initialization. Each tick wraps autoSubmitOverdueSections with advisory key 0x4c4c5453. Stop before extraction drain and DB close.

- [ ] **Step 6: Delete scheduled AWS code**

Delete infra/src/scheduled-job.ts and assert no scheduled task definition, EventBridge resources, job log group, SQS DLQ, queue policy, or DLQ alarm.

- [ ] **Step 7: Verify and commit**

Run:

    npm test --workspace=llteacher-web -- --run src/db/client.test.ts src/node/overdue-scheduler.test.ts src/node/server.test.ts src/server/jobs/autoSubmitOverdue.test.ts
    npm test --workspace=infra -- --run src/resources.test.ts
    npm run typecheck --workspace=llteacher-web
    npm run typecheck --workspace=infra

Commit the new scheduler, modified server/client/tests/docs, and removed scheduled-job.ts with message:

    refactor(infra): run overdue sweep in the app task

### Task 5: Migration failure safety

**Files:**
- Modify: apps/web/scripts/migrate.ts
- Modify: apps/web/scripts/migrate.db.test.ts
- Modify: apps/web/README.md
- Modify: infra/scripts/run-aws-migrations.sh
- Modify: infra/scripts/run-aws-migrations.test.sh

**Interfaces:**
- Produces: invalid-index detection and rebuild before concurrent create.
- Consumes: one-off ECS migration path used by Task 7.

- [ ] **Step 1: Add a failing invalid-index test**

Create an invalid test index. Assert the runner detects pg_index.indisvalid false, drops that exact name concurrently, and recreates it. Assert a valid index remains untouched.

- [ ] **Step 2: Run the database-gated test**

Run:

    DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher npm test --workspace=llteacher-web -- --run scripts/migrate.db.test.ts

Expected: FAIL before implementation.

- [ ] **Step 3: Implement safe recovery**

Parse index names only from the repository migration statement, query pg_catalog, and issue DROP INDEX CONCURRENTLY IF EXISTS before the create when invalid. Do not interpolate caller-provided identifiers.

- [ ] **Step 4: Update migration wrapper tests**

Assert the ECS migration uses public app subnets with assignPublicIp ENABLED, bounded attempts, secret-safe diagnostics, and nonzero exit before service update.

- [ ] **Step 5: Verify and commit**

Run the DB test, infra/scripts/run-aws-migrations.test.sh, and bash -n. Commit with:

    fix(db): recover invalid concurrent indexes before deploy

### Task 6: Developer-local Floci and bounded Docker storage

**Files:**
- Modify: infra/scripts/floci-up.sh
- Modify: infra/scripts/floci-down.sh
- Modify: infra/scripts/local-up.sh
- Modify: infra/scripts/local-test.sh
- Modify: infra/scripts/verify-local-stack.sh
- Create: infra/scripts/local-image-cleanup.sh
- Create: infra/scripts/local-image-cleanup.test.sh
- Modify: infra/scripts/local-test.test.sh
- Modify: infra/scripts/verify-local-stack.test.sh
- Delete: infra/scripts/tls-proxy-up.sh
- Delete: infra/scripts/tls-proxy-up.test.sh
- Delete: infra/scripts/install-local-cert.sh
- Delete: infra/Caddyfile
- Modify: Dockerfile.aws
- Modify: infra/README.md
- Modify: package.json

**Interfaces:**
- Produces: stable local image tag local in the us-west-2 ECR-shaped name.
- Produces: cleanup that removes only superseded org.llteacher.local=true images.
- Produces: a dedicated llteacher-local-builder cache capped at 2 GiB.
- Preserves: aws:local:up, verify, and down developer commands.

- [ ] **Step 1: Write failing storage tests**

Stub Docker/Pulumi. Assert local-up uses the stable tag, adds the LLTeacher label, never invokes date +%s, and invokes scoped cleanup. Give cleanup current/old labelled images plus an unrelated image and assert only old labelled IDs are removed. Assert builds use the dedicated llteacher-local-builder and its cache cleanup retains at most 2 GiB. Reject global docker system/image/volume/builder prune.

- [ ] **Step 2: Confirm failures**

Run:

    bash infra/scripts/local-image-cleanup.test.sh
    PULUMI_STACK=local bash infra/scripts/local-test.test.sh
    PULUMI_STACK=local bash infra/scripts/verify-local-stack.test.sh

- [ ] **Step 3: Remove Caddy/mkcert**

Use the Floci-published ALB socket directly over HTTP and document that Floci records HTTPS control-plane state but its 2.1.0 ELBv2 data plane is plain HTTP. Delete the proxy, certificate scripts, Caddyfile, and tests.

- [ ] **Step 4: Implement stable tagging and scoped cleanup**

Build ...dkr.ecr.us-west-2.amazonaws.com/llteacher-local/app:local with label org.llteacher.local=true. Use a named llteacher-local-builder and prune only that builder with a 2 GiB keep-storage limit. After successful deploy, remove only older labelled IDs not used by a container. Print docker system df, labelled images, and Floci volumes. List stale Floci-labelled RDS volumes separately; do not delete persistent database data without an explicit reset command.

- [ ] **Step 5: Reduce the runtime image**

After builds, prune dev dependencies in the build stage. Copy the production dependency tree plus runtime source, migrations, build outputs, scripts, and package metadata required for node:serve and db:migrate.

- [ ] **Step 6: Verify and commit**

Run all local shell tests, bash -n, and:

    docker build --tag llteacher-plan-check:local --file Dockerfile.aws .

Commit with:

    fix(infra): keep floci local and bound docker storage

### Task 7: AWS-only GitHub release

**Files:**
- Modify: .github/workflows/release.yml
- Delete: .github/workflows/local-aws.yml
- Create: infra/scripts/release-workflow.test.sh
- Create: infra/scripts/bootstrap-aws-infra.sh
- Create: infra/scripts/bootstrap-aws-infra.test.sh
- Modify: infra/scripts/run-aws-migrations.sh
- Modify: infra/src/app.ts
- Modify: apps/web/src/server/routes/hello.ts
- Modify: apps/web/src/server/routes/hello.test.ts
- Modify: infra/README.md

**Interfaces:**
- Consumes GitHub secret PULUMI_ACCESS_TOKEN only.
- Consumes GitHub variable AWS_DEPLOY_ROLE_ARN.
- Produces immutable ECR digest and ordered release.

- [ ] **Step 1: Write failing workflow assertions**

Assert release.yml includes npm ci, typecheck, tests, build, OIDC, vars.AWS_DEPLOY_ROLE_ARN, secrets.PULUMI_ACCESS_TOKEN, us-west-2, ECR push, migrations, ECS stability, and smoke check.

Assert it contains no floci, localhost:4566, aws:local, DATABASE_URL, WorkOS key, or provider key. Assert local-aws.yml is absent. Compare line numbers to prove build/test < push < migration < service enablement.

- [ ] **Step 2: Confirm failures**

Run: bash infra/scripts/release-workflow.test.sh

- [ ] **Step 3: Add base-infrastructure bootstrap**

Create a script accepting only production. It sets deployApp/provisionService false, runs noninteractive production Pulumi, and prints only ECR URL. Test refusal of local, exact production flags, and no secret config output.

- [ ] **Step 4: Rebuild the release workflow**

Use protected production environment, release tags/manual dispatch, and AWS_REGION us-west-2. Order:

1. checkout and npm ci;
2. typecheck, test, build, Docker build;
3. OIDC authentication;
4. base infrastructure/ECR bootstrap;
5. ECR push under github.sha and digest resolution;
6. Pulumi preview/update using the digest;
7. migration ECS task;
8. service enable/update and stability wait;
9. health/version smoke test.

Application secrets must not appear in inputs, env, outputs, or GitHub secrets.

- [ ] **Step 5: Add an immutable version health signal**

Pass BUILD_SHA as a normal ECS task environment value. Change /api/health to
return status and version, with version equal to BUILD_SHA or "development"
outside a release. Add a route test proving the value and make the release
smoke test reject a version that differs from the deployed commit.

- [ ] **Step 6: Remove only the Floci workflow**

Delete local-aws.yml. Keep test.yml: it is general code CI, not a local infrastructure deployment.

- [ ] **Step 7: Verify and commit**

Run:

    bash infra/scripts/release-workflow.test.sh
    bash infra/scripts/bootstrap-aws-infra.test.sh
    bash -n infra/scripts/bootstrap-aws-infra.sh infra/scripts/run-aws-migrations.sh

Commit with:

    ci(release): build test and deploy to aws

### Task 8: Full verification and local handoff

**Files:**
- Modify: infra/README.md
- Modify: README.md
- Modify: docs/architecture/tech-stack.md
- Modify: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
- Modify: docs/superpowers/plans/2026-09-21-m12-infrastructure-milestone-audit.md

- [ ] **Step 1: Update documentation**

Document exact resources/cost centers, developer-only Floci, us-west-2, secret injection and rotation, WorkOS callback, GitHub token/variable boundary, AWS release ordering, rollback digest, and deferred work.

- [ ] **Step 2: Run all automated checks**

Run:

    npm run typecheck
    npm test
    npm run build
    npm test --workspace=infra
    bash -n infra/scripts/*.sh
    bash infra/scripts/release-workflow.test.sh
    bash infra/scripts/bootstrap-aws-infra.test.sh
    bash infra/scripts/local-image-cleanup.test.sh
    git diff --check

Expected: PASS.

- [ ] **Step 3: Verify the production image**

Build llteacher-release-check:local, inspect its size, start it with non-production values, and verify /, /admin, and /api/health. Stop only that named container.

- [ ] **Step 4: Apply the exact local stack**

Run:

    npm run aws:local:up
    npm run aws:local:verify
    docker system df

Using AWS CLI endpoint overrides, verify expected VPC/ECS/RDS/S3/Secrets/ECR/ALB/ACM/Route53/IAM/Logs resources and the absence of NAT/EventBridge/SQS/CloudFront.

- [ ] **Step 5: Request review**

Use superpowers:requesting-code-review against merge-base staging. Fix findings and repeat affected plus full checks.

- [ ] **Step 6: Commit final docs**

Commit documentation and verification adjustments with:

    docs(infra): document local emulation and aws releases

- [ ] **Step 7: Stop before AWS production**

Report local URL, resources, disk use, branch/commit, tests, and required production inputs. Do not run production Pulumi; wait for explicit approval.
