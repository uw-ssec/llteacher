---
type: Decision
title: "Production Pulumi state uses a self-managed S3 backend with KMS, not Pulumi Cloud"
description: "Pulumi state moved from a planned Pulumi Cloud stack to s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra with a dedicated KMS key; bootstrap resources live outside the stack."
tags: [infra, pulumi, state, iam]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: constraint
code_refs: [infra/account/bootstrap.sh, infra/account/github-deploy-policy.template.json, infra/account/github-oidc-trust-policy.json, infra/account/pulumi-state-bucket-policy.json, infra/Pulumi.yaml, infra/Pulumi.production.yaml, .github/workflows/release.yml]
sources:
  - resource: docs/superpowers/specs/2026-09-22-s3-pulumi-backend-design.md
  - resource: docs/superpowers/plans/2026-09-22-s3-pulumi-backend-implementation.md
  - resource: docs/superpowers/plans/2026-09-15-m12-local-aws-design.md
  - resource: infra/README.md
  - resource: commit 100377e
  - resource: "PR #463"
  - resource: "PR #465"
---

## Spec proposed
The M12 local design (2026-09-15) used filesystem state for `local` and **Pulumi Cloud** for `staging` and `production`. The release workflow expected a Pulumi access token and a Cloud-qualified stack name. The S3 backend design (2026-09-22) replaced that with a DIY S3 backend in account `055237683908`:
- bucket `llteacher-pulumi-state-055237683908-us-west-2`, prefix `llteacher-infra`, stack named exactly `production`;
- KMS alias `alias/llteacher-pulumi-state`, used both for SSE-KMS state encryption and as the `awskms` Pulumi secrets provider;
- versioning on, Block Public Access on, TLS-only bucket policy, no lifecycle deletion.

## Implemented
- `infra/account/bootstrap.sh` has a read-only `check` mode and an `apply` mode that needs typed confirmation. It creates only absent resources, never modifies existing ones, and stops on any mismatch.
- It creates the state bucket, KMS key, GitHub OIDC provider (reused if present), the ELB/RDS/ECS service-linked roles (PRs #472/#473), the runtime permissions boundary, and the `llteacher-production-deploy` role.
- The deploy role carries four policies (state, compute, data, network), each kept under the 6,144-char quota.
- Policy JSON is checked in under `infra/account/`.
- `release.yml` uses `PULUMI_BACKEND_URL` and checks the exact backend and account before mutating anything (commit `100377e`).
- Local Floci still uses filesystem state under `.pulumi/local`.

## Why
- The stack must never own or delete its own state or deployment identity.
- No Pulumi Cloud token is stored in GitHub; AWS access is OIDC-only.
- The OIDC trust is limited to subject `repo:uw-ssec/llteacher:environment:production`.

## Rejected alternatives
- Pulumi Cloud. The empty Cloud stack `ksdani-uw-edu/llteacher-infra/production` was retained, not migrated.
- A bootstrap Pulumi project or CloudFormation stack for account resources.

## Consequences
- Pulumi state contains encrypted secret inputs (RDS password, Secrets Manager versions), so access to the state bucket must be protected.
- Account-level changes need an admin to re-run `bootstrap.sh`. Merging the code does not apply them.

# Related Concepts
- [Account-level AWS prerequisites live in an admin-run bootstrap script, not Pulumi](../facts/aws-account-bootstrap-outside-pulumi.md): The bootstrap script creates the state bucket and KMS key
- [AWS infrastructure topology (Pulumi, ECS Fargate)](../architecture/infra-topology.md): State backend for the Pulumi program
