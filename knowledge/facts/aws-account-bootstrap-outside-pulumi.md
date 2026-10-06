---
type: Fact
title: "Account-level AWS prerequisites live in an admin-run bootstrap script, not Pulumi"
description: "infra/account/bootstrap.sh (check/apply) creates state KMS key and bucket, GitHub OIDC provider, permission boundary, deploy policies/role and service-linked roles; fail-closed, never modifies existing resources."
tags: [infra, aws, iam, pulumi, bootstrap]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["infra/account/bootstrap.sh", "infra/account", "infra/scripts/account-bootstrap.test.mjs", "infra/scripts/bootstrap-policy.test.mjs", "infra/README.md", "infra/Pulumi.production.yaml"]
sources:
  - resource: "PR #463"
  - resource: "PR #465"
  - resource: "PR #469"
  - resource: "PR #472"
  - resource: "PR #473"
  - resource: "issue #85"
---

## Split of ownership

- **Pulumi manages only the application stack** (`infra/src`): network, ALB, ECS, RDS, S3, Secrets Manager, logs and DNS records.
- **Account-level prerequisites** are created by an AWS administrator running `infra/account/bootstrap.sh` (PR #463, which replaced hand-run README steps):
  - the Pulumi state KMS key and alias, plus the S3 state bucket (the backend decision from #85, initialised in PR #465)
  - the GitHub OIDC provider
  - the runtime permissions boundary, four scoped deploy policies, and the `llteacher-production-deploy` role
  - service-linked roles for ELB, RDS and ECS (PRs #472, #473)
- **Operator-owned DNS/TLS** (PR #469): production references an existing Route 53 hosted zone for the production domain and an operator-issued ACM certificate. The certificate must be `ISSUED`, match the domain, be in us-west-2 and be tagged `LLTeacherStack=production`. Pulumi and the release workflow both enforce this. Pulumi does not create the production zone.

## Script behaviour

- `check` is read-only. It inventories and verifies resources and prints every policy JSON exactly as `apply` would use it.
- `apply` requires a typed `yes`, creates only what is missing, and verifies each resource.
- **Fail closed:** account and region are checked first. Only an exact "not found" counts as missing. Access-denied or network errors stop the script.
- **It never changes existing resources.** A mismatch stops it, and repairs follow owner-reviewed "Approved repairs" in the README. It always reuses an existing KMS key and stops if the bucket exists without its key. SSE-C is blocked on the state bucket.
- Tests run the script against a stateful fake AWS CLI (`account-bootstrap.test.mjs`).

## Operational rule

Infra PRs that touch account-level resources come with a **post-merge operator action**: run `check`, then `apply`, then `check` from merged `staging`, confirming account and region before typing yes. The GitHub deploy role deliberately does not get IAM-creation powers such as `iam:CreateServiceLinkedRole`.
