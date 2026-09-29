# GitHub-Owned Production Secrets

## Summary

LLTeacher production operators manage application secret values as individual
GitHub Actions environment secrets in the repository's `production`
environment. A tagged release temporarily exposes those values only to the
steps that evaluate or update Pulumi. Pulumi validates the values, marks them
secret immediately, and creates or updates the AWS Secrets Manager resources
that ECS uses at runtime.

GitHub is the operator-facing source of truth. AWS Secrets Manager remains a
generated runtime delivery mechanism; operators do not create or populate its
LLTeacher application secrets manually. Pulumi's encrypted state necessarily
contains secret resource inputs because Pulumi manages the RDS instance and
Secrets Manager secret versions.

Editing a GitHub secret does not change production immediately. The new value
takes effect on the next successful tagged release.

## Goals

- Let an authorized operator enter and update all production secret values in
  one familiar interface.
- Keep plaintext values out of Git, workflow logs, command-line arguments,
  artifacts, Pulumi YAML, ECS task definitions, and ordinary ECS environment
  variables.
- Preserve AWS Secrets Manager injection at ECS task startup.
- Validate all inputs before publishing an image or mutating AWS resources.
- Keep local development independent of GitHub and production AWS resources.

## Non-goals

- A standalone secret-rotation workflow.
- Immediate production changes when a GitHub secret is edited.
- Eliminating AWS Secrets Manager from ECS runtime delivery.
- RDS-managed master credentials in this change.
- Automatically configuring the WorkOS dashboard.

## GitHub Production Configuration

The GitHub `production` environment owns these individual environment secrets:

| Name | Source |
| --- | --- |
| `DATABASE_PASSWORD` | Operator-generated initial RDS master password |
| `WORKOS_API_KEY` | WorkOS production environment API key |
| `WORKOS_CLIENT_ID` | WorkOS production environment client ID |
| `WORKOS_WEBHOOK_SECRET` | Signing secret for the production WorkOS webhook endpoint |
| `OPENROUTER_API_KEY` | Dedicated LLTeacher production OpenRouter key |
| `LLMOXIE_API_KEY` | Production credential issued by the SSEC/LLMoxie operator |
| `SESSION_SECRET` | Operator-generated standard-base64 encoding of 32 random bytes |
| `ENCRYPTION_KEY` | Operator-generated standard-base64 encoding of 32 random bytes |
| `BLIND_INDEX_KEY` | Operator-generated standard-base64 encoding of 32 random bytes |

The same environment owns one non-secret variable:

| Name | Value |
| --- | --- |
| `LLMOXIE_BASE_URL` | The production LLMoxie OpenAI-compatible endpoint, including `/v1` |

`SESSION_SECRET`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY` must be distinct.
`ENCRYPTION_KEY` and `BLIND_INDEX_KEY` are data-protection keys and must not be
rotated without a coordinated data migration. Rotating `SESSION_SECRET`
invalidates active sessions.

The WorkOS callback URL is not a separate setting. The application derives it
as `${APP_URL}/api/auth/callback`, where Pulumi derives `APP_URL` from the
production domain. An operator registers the resulting HTTPS URL in the WorkOS
production environment. The WorkOS webhook endpoint is
`${APP_URL}/api/webhooks/workos`.

## Deployment Data Flow

The production release job already targets the GitHub `production`
environment. It maps the nine secrets and `LLMOXIE_BASE_URL` into only the
steps that evaluate or update the Pulumi program:

1. Preflight validates the complete deployment input set without printing
   values.
2. Initial infrastructure bootstrap receives the inputs if it needs to run
   Pulumi.
3. Candidate creation receives the inputs for its Pulumi preview and update.
4. Final activation receives the same inputs for its Pulumi update.

Test, artifact, Docker, migration, identity-inspection, and deployment
verification steps do not receive these environment variables. The workflow
does not copy them into `$GITHUB_ENV`, `$GITHUB_OUTPUT`, an artifact, or a
command-line argument.

Production Pulumi code reads these process environment variables through one
focused loader. The loader returns Pulumi secret values and is the only
production code that knows their deployment-time names. Local and staging
continue using their existing encrypted Pulumi configuration values
`databasePassword` and `runtimeSecrets`.

Pulumi uses the production inputs as follows:

- `DATABASE_PASSWORD` becomes the RDS master password.
- Pulumi derives a percent-encoded PostgreSQL connection URL after RDS exists
  and writes it to the managed database URL Secrets Manager secret.
- The eight application values become one JSON object written to the managed
  runtime Secrets Manager secret.
- `LLMOXIE_BASE_URL` is ordinary configuration in the ECS task definition.
- ECS's execution role retrieves the database URL and runtime secret at task
  startup; the application task role receives no Secrets Manager API access.

The existing runtime and database URL secret names and ECS secret references
remain stable. A tagged release creates new secret versions and registers a new
task definition, so newly started tasks consume the synchronized values.

## Validation and Failure Behavior

Validation runs before image publication or AWS mutation. It fails closed when
any required value is missing or malformed and emits only the affected setting
name and a redacted explanation.

Validation rules are:

- Every required secret is a non-empty string.
- `SESSION_SECRET`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY` are canonical
  standard-base64 encodings of exactly 32 bytes and are pairwise distinct.
- `DATABASE_PASSWORD` is 8–128 printable ASCII characters and excludes `/`,
  `'`, `"`, `@`, and spaces, matching RDS PostgreSQL restrictions.
- `LLMOXIE_BASE_URL` is an absolute HTTPS URL with no credentials, query, or
  fragment, and its path ends in `/v1`.
- Provider-issued values receive conservative prefix checks only where the
  provider guarantees a prefix. Validation must not embed or log examples that
  resemble usable credentials.

If validation fails, no Pulumi preview or update runs. If a later deployment
step fails after a secret version is created, the workflow's existing release
failure and rollback behavior applies. Operators rerun with a new tagged
release after correcting GitHub configuration.

## IAM and Secret Boundaries

The GitHub OIDC deploy role retains permission to create and update only
Pulumi-managed LLTeacher production secrets. It no longer needs permission to
read a separate operator-owned database-password source secret.

The ECS execution role can retrieve only the managed runtime secret and the
managed database URL secret. The application task role cannot call Secrets
Manager. The AWS-managed `aws/secretsmanager` encryption key remains sufficient
for these generated secrets; no additional application KMS key is introduced.

## Testing

Tests will cover:

- A pure deployment-input validator, including missing values, redacted errors,
  exact key lengths, pairwise key distinction, database constraints, and URL
  validation.
- Pulumi resource graphs proving production creates both managed Secrets
  Manager secrets and that ECS references their ARNs rather than plaintext.
- Local graph compatibility with the existing Pulumi-secret configuration.
- Workflow/static tests proving every Pulumi update path maps all required
  inputs and unrelated steps do not.
- IAM policy tests retaining least-privilege access to the two generated runtime
  secrets.
- Type checking, infrastructure tests, shell-policy tests, and the repository's
  full test suite before the implementation PR is opened.

Tests and fixtures use conspicuously fake values. No real production value is
read, printed, or committed.

## Operations

Initial setup consists of adding the nine environment secrets and the
`LLMOXIE_BASE_URL` environment variable, registering the derived callback and
webhook URLs in the WorkOS production environment, then creating a tagged
release after the implementation is merged.

For later updates, an operator changes the relevant GitHub production
environment value and creates the next tagged release. Provider credentials
may be rotated this way. Changes to `DATABASE_PASSWORD`, `ENCRYPTION_KEY`, or
`BLIND_INDEX_KEY` require a coordinated migration and are not routine secret
rotation.

The infrastructure runbook will document value provenance, validation,
release behavior, recovery, and the distinction between GitHub as the operator
source and AWS Secrets Manager as the generated runtime sink.

## Future Work

Move the RDS instance to RDS-managed master credentials. That future change
should evaluate the database URL delivery design, rotation coordination, and
migration behavior before removing `DATABASE_PASSWORD` from GitHub.
