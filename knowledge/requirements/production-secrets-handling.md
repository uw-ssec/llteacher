---
type: Requirement
title: "Production secrets come only from GitHub environment secrets and Secrets Manager, never from code, logs, or arguments"
description: "Production values live as GitHub production-environment secrets, validated and redacted before any AWS mutation, delivered via two generated Secrets Manager secrets read only by the ECS execution role; local creds stay local."
tags: [secrets, security, infra, operations]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
code_refs: [infra/src/deployment-inputs.ts, infra/src/app.ts, .github/workflows/release.yml, infra/account/runtime-permissions-boundary.json, apps/web/src/runtime/config.ts, infra/README.md]
sources:
  - resource: docs/adr/0001-operator-owned-production-secrets.md
  - resource: docs/superpowers/specs/2026-09-29-github-production-secrets-design.md
  - resource: infra/README.md
  - resource: docs/superpowers/plans/2026-09-17-pr-458-review-remediation.md
  - resource: "PR #467"
  - resource: "PR #468"
  - resource: "issue #323"
  - resource: "PR #458"
  - resource: "PR #457"
  - resource: "discussion #319"
---

## The requirement
- **Source of truth.** Production application secrets live **only** as individual GitHub `production` environment secrets. Required: `DATABASE_PASSWORD`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_WEBHOOK_SECRET`, `LLMOXIE_API_KEY`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`. Optional: `OPENROUTER_API_KEY`. `LLMOXIE_BASE_URL` is a non-secret environment variable. Do not add production `databasePassword` or `runtimeSecrets` Pulumi config.
- **Transport.** The release workflow maps them only into the validation and Pulumi steps. They are never written to `$GITHUB_ENV`, `$GITHUB_OUTPUT`, artifacts, CLI arguments, Docker build args, Pulumi YAML, ECS plain environment, or logs. Workflow tests guard this (commit `7608518`).
- **Validation first.** Validation fails closed and redacts before image publish or any AWS mutation. Errors name the setting and the rule, never the value.
- **Delivery.** Pulumi writes two generated secrets (DB URL, runtime JSON). Only the ECS **execution** role can `GetSecretValue`, and only for those two ARNs. The app task role has no Secrets Manager access. Operators never hand-edit the generated secrets, because the next release would overwrite the edit.
- **Effect timing.** Editing a GitHub secret does nothing until the next successful tagged release, which rotates the candidate task (commit `357edb7`).
- **Non-routine rotation.** Changing `SESSION_SECRET` invalidates sessions. Changing `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, or `DATABASE_PASSWORD` needs a coordinated migration.
- **Local.** Development credentials are loaded through encrypted local Pulumi config or a shell environment. They never go into shell history, chat, source, or build args. Local placeholders allow boot tests only.
- **No AWS keys or DB URLs in GitHub.** OIDC only. Test CI uses disposable Postgres credentials and ephemeral keys.
- **State backend.** Pulumi state contains encrypted secret inputs, so protect the S3 state bucket and KMS key.

## Future
Adopt RDS-managed master credentials, then remove `DATABASE_PASSWORD` from GitHub.

## From the issue tracker and reviews

## Decision (ADR 0001, PR #467)

- Operators set the eight required secrets in the protected GitHub **`production` environment**: `DATABASE_PASSWORD`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_WEBHOOK_SECRET`, `LLMOXIE_API_KEY`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`. `LLMOXIE_BASE_URL` is a non-secret environment variable.
- A tagged release passes them only to the validation and Pulumi steps. Validation runs **before any AWS mutation**.
- Pulumi writes two generated AWS Secrets Manager secrets: one holds the derived database URL, the other a JSON blob of app credentials. ECS reads them through the **execution role** at task start. The application task role has **no** Secrets Manager read permission. Operators never edit the generated secrets by hand.
- Secret changes take effect on the next tagged release.
- Local and staging stacks keep encrypted Pulumi config (`databasePassword`, `runtimeSecrets`).

## Optional keys (PR #468)

`OPENROUTER_API_KEY` is optional. When it is absent, it is left out of the Secrets Manager JSON and the ECS bindings entirely. Delete the GitHub secret rather than storing an empty or quoted-empty value. The legacy no-config grading fallback uses LLMoxie.

## Fail fast (PR #458 review)

Runtime config fails at startup if any required WorkOS, provider, session, encryption or webhook secret is missing. OAuth, logout and cookie origins come from the configured `APP_URL`, never from forwarded host headers.

## Database-held credentials

- `organization_credentials.secret_ref` stores an **env binding name**, never key material. #323 found that `resolveApiKey` did `env[secretRef]` with no allowlist, which would let a DB string read `ENCRYPTION_KEY` or `DATABASE_URL` once a credential write path existed. It is now constrained to an allowlist.
- Canvas instructor tokens are the exception. They are stored encrypted (`encrypted_secret`, AES-256-GCM via `IdentityCipher`, PR #457) and only the last characters are shown in the UI.

## Key sharing

`ENCRYPTION_KEY` and `BLIND_INDEX_KEY` must match across every process that shares a database (see bugs/blind-index-key-drift-forks-accounts).
