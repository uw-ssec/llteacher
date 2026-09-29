---
status: accepted
---

# Use GitHub production environment secrets as the operator source of truth

## Decision

The GitHub `production` environment is the operator-facing source of truth for
LLTeacher production application secrets. Operators set nine individual
environment secrets: `DATABASE_PASSWORD`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_WEBHOOK_SECRET`, `OPENROUTER_API_KEY`, `LLMOXIE_API_KEY`,
`SESSION_SECRET`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY`. The non-secret
`LLMOXIE_BASE_URL` is a production environment variable. Local and staging
stacks retain their encrypted Pulumi `databasePassword` and `runtimeSecrets`
configuration; production does not use those config keys.

A successful tagged release validates these inputs, gives them only to the
steps that run Pulumi, and uses Pulumi to create or update the two generated
AWS Secrets Manager runtime secrets. Pulumi sets the RDS master password,
derives the percent-encoded database connection URL, and writes that URL to
one generated secret. It writes the eight application credentials and keys
to the other generated secret as JSON. ECS obtains both through its execution
role when a task starts. The application task role has no Secrets Manager
read permission. Operators do not manually populate or edit either generated
AWS secret.

## Consequences

- Editing a GitHub environment secret alone does not change production. The
  next successful tagged release synchronizes the value to AWS and starts a
  task that consumes the new secret version.
- Deployment input validation fails before image publication or AWS mutation
  and reports only setting names and redacted explanations.
- The GitHub OIDC deployment role may manage only the Pulumi-generated
  LLTeacher production secret resources. It does not need to read a separate
  database-password source secret. The ECS execution role can read only the
  generated runtime and database URL secrets.
- Pulumi's encrypted state necessarily contains secret resource inputs,
  including the RDS master password and Secrets Manager secret versions.
  Protect access to the state backend.
- Rotating `SESSION_SECRET` invalidates active sessions. Rotation of
  `ENCRYPTION_KEY` or `BLIND_INDEX_KEY` requires a coordinated data migration;
  changing `DATABASE_PASSWORD` requires coordinated RDS and connection
  migration. These are not routine provider-key rotations.
- Future work is to adopt RDS-managed master credentials and review database
  URL delivery and rotation before removing `DATABASE_PASSWORD` from GitHub.

See the [GitHub-owned production secrets design](../superpowers/specs/2026-09-29-github-production-secrets-design.md)
for validation, release data flow and operational details.
