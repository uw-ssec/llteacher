# Operator-owned production secrets design

## Status

Draft for written review. The architectural direction was approved in conversation on 2026-09-29; implementation must not begin until this document is reviewed and an implementation plan is approved.

## Context

The production release currently expects two secret Pulumi configuration values: `runtimeSecrets` and `databasePassword`. Pulumi copies `runtimeSecrets` into an AWS Secrets Manager secret, uses `databasePassword` to create RDS, constructs `DATABASE_URL`, and writes that URL into a second Secrets Manager secret. This makes encrypted Pulumi state an additional source of application credentials and requires an operator to enter the runtime bundle through Pulumi.

PR #465 initializes the empty `production` stack in the S3 backend and records its KMS secrets provider. It is a prerequisite for the first production apply, but it intentionally does not populate production application secrets.

## Goals

- Make operator-owned AWS Secrets Manager secrets the source of truth for production credentials.
- Keep application runtime secret values out of GitHub Actions and Pulumi configuration/state.
- Preserve the existing `DATABASE_URL` application contract for the first production deployment.
- Limit every identity to the exact secrets it needs.
- Preserve the local Floci development workflow.
- Provide explicit, fail-closed bootstrap and rotation procedures.

## Non-goals

- Do not introduce HashiCorp Vault, Azure Key Vault, GitHub repository secrets, or another secret service.
- Do not add automatic application-secret rotation.
- Do not migrate the application to RDS-managed master credentials in this change.
- Do not change database migrations, release tagging, domain provisioning, or WorkOS callback behavior.
- Do not place the public application or callback URL in a secret store.

## Decision

Use two operator-owned AWS Secrets Manager secrets in account `055237683908`, region `us-west-2`:

1. `llteacher-production-runtime`, a JSON document containing the application runtime keys.
2. `llteacher-production-database-password`, a JSON document containing only `DATABASE_PASSWORD`.

Use separate secrets so the GitHub deployment role can read the database bootstrap credential without gaining access to WorkOS, LLM provider, or application cryptographic keys. The additional Secrets Manager storage charge is an accepted least-privilege trade-off.

Pulumi configuration stores only the two non-secret ARNs. Pulumi never reads the runtime secret. It reads the database-password secret, marks the selected JSON value secret, passes it to RDS, derives the existing `DATABASE_URL`, and stores that URL in a Pulumi-managed Secrets Manager secret.

## Secret schemas

The operator-owned runtime secret must be a JSON object containing exactly these required, non-empty string keys:

```json
{
  "WORKOS_API_KEY": "...",
  "WORKOS_CLIENT_ID": "...",
  "WORKOS_WEBHOOK_SECRET": "...",
  "OPENROUTER_API_KEY": "...",
  "LLMOXIE_API_KEY": "...",
  "SESSION_SECRET": "...",
  "ENCRYPTION_KEY": "...",
  "BLIND_INDEX_KEY": "..."
}
```

The database-password secret must be a JSON object containing exactly one required, non-empty string key:

```json
{
  "DATABASE_PASSWORD": "..."
}
```

The database password must satisfy current RDS PostgreSQL password constraints. `SESSION_SECRET`, `ENCRYPTION_KEY`, and `BLIND_INDEX_KEY` must be distinct base64-encoded 32-byte values.

## Public URL and WorkOS callback

The LLTeacher public URL is configuration, not a secret. Production derives `APP_URL` as `https://<domainName>` only after `domainReady=true` and a reviewed ACM certificate ARN are configured. LLTeacher derives the WorkOS callback as:

```text
https://<domainName>/api/auth/callback
```

An operator registers that exact callback in the production WorkOS environment. Neither URL belongs in Secrets Manager.

## Configuration contract

Add two production Pulumi configuration keys:

```text
runtimeSecretArn
databasePasswordSecretArn
```

Both must identify Secrets Manager secrets in account `055237683908` and region `us-west-2`. Production rejects missing, malformed, wrong-account, or wrong-region ARNs. Local stacks continue using their generated `runtimeSecrets` and `databasePassword` values so local development does not depend on AWS production secrets.

Remove `runtimeSecrets` and `databasePassword` as required production Pulumi configuration. A production preview must fail closed if either ARN is absent or invalid.

## Infrastructure data flow

### Runtime application secret

Pulumi places `runtimeSecretArn` into the ECS task definition without calling `GetSecretValue`. Each required environment variable uses the existing Secrets Manager JSON-key ARN syntax. At task startup, the ECS agent uses the execution role to retrieve the selected values.

The task definition continues to inject only the eight named keys. The runtime secret is never copied into another Pulumi-managed secret.

### Database password and URL

Pulumi retrieves the current version of `databasePasswordSecretArn`, parses `DATABASE_PASSWORD`, and immediately wraps the selected value as a Pulumi secret. It passes that value to `aws.rds.Instance.password`.

After RDS resolves its hostname and port, Pulumi constructs the existing URL:

```text
postgres://llteacher:<encoded-password>@<host>:<port>/llteacher?sslmode=verify-full
```

Pulumi stores the URL in the existing `llteacher-production-database-url` Secrets Manager secret. ECS and the migration task continue receiving only `DATABASE_URL`, so application and migration code do not change in this phase.

Because the password is an RDS resource input, an encrypted copy remains in Pulumi state. This is an explicitly accepted temporary limitation, not the target end state.

## IAM boundaries

### Operator/bootstrap identity

May create, validate, populate, tag, and deliberately rotate the two operator-owned source secrets. Secret entry must use hidden input or an owner-only temporary file supplied through the approved password workflow. Commands and logs must never print values.

### GitHub deployment role

- May call `secretsmanager:GetSecretValue` and `DescribeSecret` only for `llteacher-production-database-password`.
- Must not read, write, tag, rotate, or delete `llteacher-production-runtime`.
- Retains the permissions required to manage the Pulumi-owned database URL secret.
- Must not gain wildcard secret-management permissions as part of this change.

### ECS execution role

- May call `secretsmanager:GetSecretValue` only for `llteacher-production-runtime` and the Pulumi-owned database URL secret.
- Must not read the database-password source secret.

### Application task role

Receives no Secrets Manager API permission. Secrets are injected before container startup by the ECS execution role.

## Release workflow

The GitHub workflow does not fetch or export runtime credentials. Its Pulumi invocation reads the database-password source through the AWS provider only because RDS requires the value. The workflow must not add secret values to `$GITHUB_ENV`, step outputs, command-line arguments, artifacts, or logs.

The existing order remains:

1. Test and build the immutable release image.
2. Authenticate to AWS through GitHub OIDC.
3. Select and refresh the S3-backed Pulumi stack.
4. Prepare base infrastructure and ECR.
5. Push the tested image.
6. Register a candidate task definition.
7. Run candidate migrations using injected `DATABASE_URL`.
8. Activate the migrated candidate.

No release may proceed until both source-secret ARNs pass validation.

## Bootstrap sequence

1. Merge PR #465 and verify the S3-backed `production` stack can decrypt configuration using the committed KMS provider metadata.
2. An authorized operator creates both source secrets with ownership tags and validates their schemas without printing values.
3. Record only their ARNs in Pulumi production configuration.
4. Preview the infrastructure and review secret references, IAM policies, replacements, network exposure, backups, deletion protection, and cost.
5. Perform the separately approved first base apply.
6. Configure the production domain, certificate, and WorkOS callback using the existing domain runbook.
7. Rerun the failed `v0.1.1` release only after all production gates pass; no new tag is required.

## Rotation and recovery

### Runtime secret

Updating the Secrets Manager value does not update running ECS tasks. After an approved change, start a new release or force a reviewed ECS deployment so new tasks receive the current version. Retain the previous secret version for rollback investigation according to the operator retention policy.

### Database password

Do not enable independent automatic rotation. Rotation is a coordinated maintenance operation:

1. Generate and store a new password version in the operator-owned database-password secret.
2. Run a reviewed Pulumi preview.
3. Apply the RDS password and derived database URL update.
4. Replace application tasks so they receive the updated `DATABASE_URL`.
5. Verify migrations, health, and database connectivity.

If any step fails after RDS changes its password, use the retained previous secret version and the same coordinated process to restore consistency. Do not edit RDS, the derived URL secret, and ECS independently.

## Future migration: RDS-managed credentials

Create a tracked follow-up to remove `databasePasswordSecretArn` and the database password from Pulumi state. The future design should:

- set RDS `manageMasterUserPassword=true`;
- consume the RDS-managed Secrets Manager ARN;
- change application and migration startup to construct connection settings without a Pulumi-derived `DATABASE_URL` secret;
- define how running ECS tasks refresh credentials after RDS rotation;
- enable and verify an appropriate rotation schedule;
- remove obsolete GitHub and ECS secret permissions only after migration succeeds.

This follow-up must be completed before claiming fully AWS-managed database credential rotation.

## Code and documentation changes

- `infra/src/config.ts` and `infra/src/config.test.ts`: add and validate the two ARN settings with production/local rules.
- `infra/src/database.ts`: select production database password from the operator-owned secret; preserve local behavior; retain the derived URL secret.
- `infra/src/app.ts`: reference the operator-owned runtime secret ARN and adjust dependencies.
- `infra/src/resources.test.ts`: cover secret ownership, JSON-key injection, secret propagation, and role access.
- `infra/Pulumi.production.yaml`: add only the two non-secret source ARNs after operator creation.
- `infra/account/github-data-policy.json`, the runtime permissions boundary if necessary, and policy tests: enforce the IAM matrix above.
- `infra/README.md`: replace production `runtimeSecrets` and `databasePassword` entry with operator-owned secret creation, validation, preview, rotation, and recovery instructions.
- `.github/workflows/release.yml` and workflow tests: change only if validation must explicitly assert the two ARN settings; never add secret retrieval steps.
- Add a tracked future-work item for the RDS-managed-credentials migration described above.

## Verification

- Unit tests reject missing and cross-account/cross-region secret ARNs.
- Pulumi mock tests prove production creates no runtime `Secret` or `SecretVersion` resource.
- Pulumi mock tests prove local stacks retain their current generated secret behavior.
- ECS task-definition tests prove each runtime key points to the operator-owned runtime ARN and `DATABASE_URL` points to the derived URL secret.
- Policy tests prove GitHub cannot read the runtime secret and ECS cannot read the database-password source secret.
- Workflow tests prove no secret is placed in GitHub environment variables, outputs, arguments, or artifacts.
- Bootstrap tests prove schema checks are fail-closed and redact values.
- A production preview shows no application resources before the separately approved first apply and no unexpected secret replacement or deletion.

## Acceptance criteria

- No production runtime credential is stored in Pulumi configuration or copied into a Pulumi-owned runtime secret.
- The production database password source is AWS Secrets Manager, not Pulumi configuration.
- Pulumi state contains the database password only as encrypted resource input material, documented as temporary technical debt.
- GitHub can read only the database-password source secret; ECS can read only the runtime and derived database URL secrets.
- The application and migration task continue to receive their existing environment contracts.
- Public URL and WorkOS callback configuration remain outside secret storage.
- Rotation and rollback procedures identify the required ECS replacement and coordinated database update.
- The future RDS-managed-credentials migration is explicitly tracked.
