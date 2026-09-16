# M12 Floci and Pulumi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the approved one-service AWS topology locally through Floci using Pulumi.

**Architecture:** Pulumi has `local`, `staging`, and `production` stack configs. The local wrapper selects filesystem state and Floci endpoints; production uses the same resources with real AWS provider defaults.

**Tech Stack:** Pulumi TypeScript, AWS provider, Floci, ECS/Fargate, RDS PostgreSQL, ECR, ALB, S3, Secrets Manager, EventBridge.

**Spec:** `docs/plan/2026-09-15-m12-local-aws-design.md`

## Global Constraints

- Local commands must never target real AWS.
- Local ingress is trusted HTTPS at `llteacher.local`.
- One app ECR repository, ECS service, and ALB target group only.
- Do not provision deferred queues, export storage, CloudFront, OIDC, or backup/DR resources.

---

### Task 1: Pulumi project and stack guards

**Files:** create `infra/Pulumi.yaml`, `infra/Pulumi.local.yaml`, `infra/Pulumi.staging.yaml`, `infra/Pulumi.production.yaml`, `infra/package.json`, `infra/tsconfig.json`, `infra/src/config.ts`, `infra/src/config.test.ts`.

- [ ] Write failing configuration tests proving the local stack requires a Floci endpoint and production rejects that endpoint.
- [ ] Implement `loadInfraConfig()` returning `environment`, `isLocal`, `domainName`, `imageTag`, and endpoint settings; use Pulumi secrets only for values explicitly marked secret.
- [ ] Add local filesystem and Pulumi Cloud wrapper selection outside committed stack config.
- [ ] Run `npm test --workspace=infra` and `npm run typecheck --workspace=infra`.
- [ ] Commit: `feat(infra): add guarded Pulumi stack configuration`.

### Task 2: Minimum resource graph

**Files:** create `infra/src/index.ts`, `infra/src/network.ts`, `infra/src/database.ts`, `infra/src/app.ts`, `infra/src/scheduled-job.ts`, `infra/src/outputs.ts`; create `infra/src/config.test.ts` additions.

- [ ] Write failing unit tests for one app service/resource naming and for local-only endpoint settings.
- [ ] Implement VPC/subnets/security groups/egress, HTTPS ALB, one ECR repository, one ECS cluster/service/task definition, RDS Postgres + pgvector bootstrap, private materials bucket, secret references, CloudWatch logs, and the one EventBridge ECS-job target.
- [ ] Expose only non-secret outputs: app URL, ECR URL, materials bucket name, and log-group names.
- [ ] Run `pulumi -C infra preview --stack local` with Floci running; assert no real AWS endpoint appears in command output.
- [ ] Commit: `feat(infra): provision minimal local AWS topology`.

### Task 3: Local TLS and Floci lifecycle

**Files:** create `infra/scripts/floci-up.sh`, `infra/scripts/floci-down.sh`, `infra/scripts/install-local-cert.sh`, `infra/scripts/verify-local-stack.sh`; modify `.gitignore` and `infra/README.md`.

- [ ] Write shell-level checks that reject a non-local stack in every Floci lifecycle script.
- [ ] Pin the Floci image, persist development volumes, create a disposable test mode, create a trusted `mkcert` certificate for `llteacher.local`, and install/print the hosts-file mapping.
- [ ] Make verification request `https://llteacher.local/`, `https://llteacher.local/admin`, and `https://llteacher.local/api/health` with certificate validation enabled.
- [ ] Run the scripts locally and record the exact prerequisite versions in `infra/README.md`.
- [ ] Commit: `feat(infra): add safe Floci local lifecycle`.
