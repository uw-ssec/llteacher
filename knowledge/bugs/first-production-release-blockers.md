---
type: Bug
title: "First AWS production release blockers: new stack refresh and missing service-linked roles"
description: "Bringing up production hit a config refresh failing on a stack with no deployments, then missing ELB/RDS/ECS service-linked roles (ecs:RunTask could not assume the ECS role); all now created in account bootstrap."
tags: [infra, aws, pulumi, release, iam]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: ["infra/account/bootstrap.sh", "infra/scripts/account-bootstrap.test.mjs", ".github/workflows/release.yml", "infra/README.md"]
sources:
  - resource: "PR #465"
  - resource: "PR #466"
  - resource: "PR #472"
  - resource: "PR #473"
---

## Sequence (2026-09-29 to 10-01)

1. **PR #465:** `pulumi stack init production` on the S3/KMS backend added `secretsprovider` and `encryptedkey` to `infra/Pulumi.production.yaml`. These must be committed so CI can decrypt the stack config. Note: `pulumi stack` reports `Secrets provider: cloud` even though the config uses `awskms://alias/...`. Verify that decryption works before adding secrets.
2. **PR #466:** the release workflow's Pulumi config refresh failed with "no previous deployment" because the new stack had no checkpoint. Fix: detect deployment history, skip the refresh only for a never-deployed stack, keep it for established stacks, and fail closed on malformed history output.
3. **PR #472:** first-time creation of the ALB and RDS needs the AWS service-linked roles `AWSServiceRoleForElasticLoadBalancing` and `AWSServiceRoleForRDS`. The administrator-run account bootstrap now creates or verifies them, so the GitHub deploy role does **not** need `iam:CreateServiceLinkedRole`.
4. **PR #473:** a later run reached "Run candidate migrations", then `ecs:RunTask` failed with "Unable to assume the service linked role". `AWSServiceRoleForECS` was missing. It was added, and the bootstrap loop is now derived from a service array so future roles need a one-line change.

## Lessons

- On a fresh AWS account, service-linked roles are an account-level prerequisite. Create them in the admin bootstrap (`bootstrap.sh check`, then `apply`, then `check`), not by giving CI broad IAM.
- Release workflows need an explicit first-deploy path. Commands that assume history (refresh, previous-revision lookups) fail on a new stack.
- Each fix needs a post-merge **operator action** (an admin re-runs the bootstrap). Merging alone does not change AWS.
