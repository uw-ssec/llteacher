---
type: Requirement
title: "All regional AWS resources live in us-west-2, and deploys refuse a stack whose region is stale"
description: "Every regional resource (including ACM for the ALB) is in us-west-2; IAM/Route 53 are global. Releases verify aws:region=us-west-2 before mutation and an existing us-east-1 stack must be migrated deliberately, never reconfigured."
tags: [infra, aws, region]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: constraint
code_refs: ["infra/src/config.ts", "infra/src/config.test.ts", "infra/Pulumi.production.yaml", ".github/workflows/release.yml"]
sources:
  - resource: "docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md"
  - resource: "infra/README.md"
  - resource: "docs/superpowers/specs/2026-09-22-s3-pulumi-backend-design.md"
---

## The requirement
The 2026-09-21 design: "Put every regional AWS resource in `us-west-2`", including ACM for the ALB. Region and availability zones (`us-west-2a`/`us-west-2b`) are derived from configuration, and every hard-coded `us-east-1` reference was removed. The S3 state bucket, KMS key, and deployment role all sit in account `055237683908` / `us-west-2`.

## Enforcement
- `infra/src/config.ts` and its tests assert `us-west-2` for local and production configurations.
- After refresh and before the first AWS mutation, the release workflow checks that the S3 stack still says `aws:region=us-west-2` and `environment=production`. It also checks for a valid `domainName` with `domainReady=true` and a `certificateArn` in the exact account and region.
- The bootstrap procedure checks the configured CLI region and caller account before any mutation. Explicitly passing `--region` does not replace that check.

## Never do this
If an existing stack reports `us-east-1` and has resources, **stop**. Do not run `pulumi config set aws:region us-west-2`. That retargets the provider without migrating the resources. Take inventory, decide whether to retain/import or replace each resource, preserve the database and S3 data, and run a reviewed migration plan with rollback. Only an empty stack may be reconfigured directly.

## Context
Earlier artifacts referenced `us-east-1` (Pulumi defaults) and `us-east-2` (Neon Object Storage, next to the Neon database). The LLMoxie gateway runs in Azure `westus2`. Co-locating on the West Coast is presumably intentional (inferred).
