---
type: Architecture
title: "AWS infrastructure topology (Pulumi, ECS Fargate)"
description: "infra/ is a Pulumi TS program for us-west-2: VPC without NAT, ALB, one Fargate task on 8080, private RDS Postgres 16, versioned S3 bucket, two Secrets Manager secrets, ECR; Floci 2.1.0 emulates the same graph locally."
tags: [architecture, infra, aws, pulumi, ecs]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: context
code_refs: ["infra/src/index.ts", "infra/src/app.ts", "infra/src/network.ts", "infra/src/database.ts", "infra/src/config.ts", "infra/src/deployment-inputs.ts", "infra/src/dns.ts", "infra/Pulumi.yaml", "infra/Pulumi.production.yaml", "infra/account"]
sources:
  - resource: "infra/README.md"
  - resource: "infra/src/index.ts"
  - resource: "infra/src/config.ts"
  - resource: "docs/adr/0001-operator-owned-production-secrets.md"
  - resource: "37924ba"
---

**Program.** `infra/src/index.ts` composes `createNetwork`, `createDataResources`, `createApplication` with name prefix `llteacher-<environment>`. Stacks: `local` (Floci, file backend `.pulumi/local`), `staging`, `production` (S3 backend `s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra`, KMS secrets provider). infra compiles with plain `tsc` (TypeScript 5.9, unlike the apps' TS 7) to `infra/dist`.

**Resources:** VPC, IGW, two public subnets (ALB + app tasks with public IPs, no NAT by design), two private DB subnets; SGs internet -> ALB -> app:8080 -> db:5432; ALB (HTTP for bootstrap, HTTPS when `domainReady`); ECS cluster, task definition, one service; ECR; RDS PostgreSQL 16 (pgvector enabled by migrations, 7-day backups in prod); one private versioned S3 bucket (materials + knowledge snapshots); two Secrets Manager secrets (DB URL + structured app credentials); execution/task roles; one CloudWatch log group. Optional Route 53 zone and operator-owned ACM cert for production.

**Key config flags** (infra/src/config.ts): `provisionService` and `deployApp` (both default true unless set "false"; `desiredCount = deployApp ? 1 : 0`), `serviceTaskDefinition` (pin the service to a specific revision), `imageDigest`/`imageTag`, `domainReady` (production refuses `deployApp` without it), `flociEndpoint`.

**IAM model:** the execution role reads exactly the two secrets and injects them as env vars; the task role reaches S3 only under `courses/*/materials/*` and `courses/*/knowledge/*`. This is one shared role, not per-course isolation; course authorization is the app's job. No version-history S3 access for the app.

**Secrets:** local/staging use encrypted Pulumi config (`databasePassword`, `runtimeSecrets` JSON). Production takes nine GitHub `production` environment secrets via deployment inputs validated by `infra/dist/validate-production-inputs.js` (ADR 0001); never add production secrets to Pulumi config.

**Floci locally:** `floci/floci:2.1.0` container on network `llteacher-local`, ports 4566 (AWS API), 8080 (ALB HTTP), 8443; RDS image `pgvector/pgvector:pg16`. It cannot prove TLS, IAM isolation, DNS or real networking.

Production provisioning requires the release owner's explicit approval.
