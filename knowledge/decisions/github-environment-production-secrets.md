---
type: Decision
title: The GitHub production environment is the source of truth for production secrets (ADR 0001)
description: "Operators set individual secrets in the protected GitHub production environment; tagged releases pass them only to validation and Pulumi steps, which write two generated AWS Secrets Manager secrets for ECS."
tags: [infra, secrets, adr, security]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:34Z" }
status: stable
governance: constraint
code_refs: [infra/src/deployment-inputs.ts, infra/src/deployment-inputs.test.ts, infra/src/validate-production-inputs.ts, infra/src/app.ts, .github/workflows/release.yml, docs/adr/0001-operator-owned-production-secrets.md]
sources:
  - resource: docs/adr/0001-operator-owned-production-secrets.md
  - resource: docs/superpowers/specs/2026-09-29-github-production-secrets-design.md
  - resource: docs/superpowers/plans/2026-09-29-github-production-secrets-implementation.md
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: "PR #467"
  - resource: commit e017807
---

## Spec proposed
- **2026-09-21 minimal-production design:** application secrets are explicitly "not copied into GitHub". They are entered once as encrypted Pulumi stack config (`databasePassword`, `runtimeSecrets`) and written into Secrets Manager.
- **2026-09-29 design and ADR 0001:** this is reversed. GitHub's protected `production` environment becomes the operator-facing source of truth. The design listed nine required secrets, including `OPENROUTER_API_KEY`, plus the non-secret variable `LLMOXIE_BASE_URL`.

## Implemented
- `infra/src/deployment-inputs.ts` is the one loader that knows the deployment-time names.
- It fails closed with redacted errors before any image publish or AWS mutation. It checks:
  - three distinct canonical base64 32-byte keys (`SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`);
  - RDS password rules;
  - `LLMOXIE_BASE_URL` is HTTPS, ends in `/v1`, and has no credentials, query, or fragment;
  - `sk_`/`client_`/`sk-or-` prefixes.
- Pulumi writes two generated secrets: the percent-encoded DB URL, and a JSON runtime blob.
- `infra/src/app.ts` references them by ARN in the task definition. Only the ECS **execution** role can read them; the task role has no Secrets Manager access.
- **Divergence:** `OPENROUTER_API_KEY` is optional in code (`RequiredRuntimeSecretName` excludes it), following commit `e017807` ("Make OpenRouter optional in production", #468). The spec required it. ADR 0001 was updated to say eight required secrets plus an optional OpenRouter key.
- Local and staging stacks still use the encrypted Pulumi config keys.

## Why
Operators get one familiar interface for entering and updating secrets. Plaintext stays out of Git, logs, CLI args, artifacts, YAML, and plain ECS env vars.

## Rejected alternatives
- Operator-populated AWS secrets.
- Pulumi-config-only production secrets (the 09-21 design).
- A standalone rotation workflow.

## Consequences
- Editing a GitHub secret changes nothing until the next successful tagged release.
- Rotating `SESSION_SECRET` logs everyone out.
- `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, and `DATABASE_PASSWORD` need coordinated migrations to rotate. See `requirements/production-secrets-handling`.

# Related Concepts
- [Production secrets come only from GitHub environment secrets and Secrets Manager, never from code, logs, or arguments](../requirements/production-secrets-handling.md): The constraint this decision sets
- [Releases deploy to AWS only from version tags, and migrations run before the new task is activated](tag-gated-aws-release-pipeline.md): Secrets reach Pulumi only inside the release workflow
