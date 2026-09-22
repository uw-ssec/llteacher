# Minimal AWS stack and developer-local Floci

Production provisioning still requires the release owner's explicit approval.
This branch prepares the configuration; running local commands does not authorize
an AWS deployment.

## What runs

One Node 24/Hono ECS Fargate task serves the student app (`/`), instructor
console (`/admin`) and API (`/api`). All regional resources use **us-west-2**.

| Resources | Purpose |
| --- | --- |
| VPC, internet gateway, public route table, two public subnets/associations | ALB and app egress without a NAT gateway. |
| Two private database subnets and DB subnet group | Keep RDS inaccessible from the internet. |
| Three security groups | Internet → ALB → app:8080 → database:5432; no public app-port ingress. |
| ALB, target group, listener | One origin and task health/routing. HTTP for bootstrap; HTTPS when domain-ready. |
| Optional managed Route 53 zone, ACM certificate/validation records, alias | Domain ownership and trusted TLS after selecting/delegating a domain. |
| ECS cluster, task definition, one service/task; ECR repository | Managed compute and immutable AWS release images. |
| RDS PostgreSQL 16, encrypted 20 GiB storage | Application data; pgvector initialized by migrations, seven-day production backups. |
| One private, encrypted, versioned S3 bucket and its safeguards | Uploaded originals and durable knowledge snapshots. |
| Two Secrets Manager secrets/versions | Database connection and structured application credentials. |
| Execution/task IAM roles, execution-policy attachment, scoped secret/S3 policies | Pull image, write logs, inject secrets, access course objects. |
| One CloudWatch log group | Bounded application logs. |

IAM and Route 53 are global. No NAT/EIP, CloudFront, SQS/DLQ, EventBridge,
separate worker, scheduled ECS task, Redis, or EFS is created. The main recurring
costs are ALB, one Fargate task, RDS, and stored data—not each control-plane
object.

The overdue sweep runs at startup and hourly, with a same-session PostgreSQL
advisory lock. Extraction remains in-process; interrupted work is visible and
retryable. Knowledge files use an S3-backed snapshot with a temporary OKF
working copy. Scaling to multiple app tasks is not supported by this release.
Replacement stops the old app before starting the new one, so releases cause
brief downtime. Migrations complete before that replacement.

When switching an existing filesystem knowledge store to S3, migrate it
explicitly first. A nonempty local course without a remote snapshot is refused
rather than silently deleted or uploaded. Fresh temporary working roots restore
normally; do not point production at an unreviewed legacy directory.

## Run locally

Prerequisites: Docker Desktop, Node 24/npm, Pulumi CLI, AWS CLI v2, jq, curl,
OpenSSL and Bash. From repository root:

```sh
npm ci
npm run aws:local:up
npm run aws:local:verify
```

- App: [http://localhost:8080](http://localhost:8080)
- Instructor console: [http://localhost:8080/admin](http://localhost:8080/admin)
- Health/version: [http://localhost:8080/api/health](http://localhost:8080/api/health)
- Emulator API: [http://localhost:4566](http://localhost:4566)

Floci 2.1.0 creates the actual ECS- and RDS-backed Docker containers. There is no
directly launched substitute app/database and no Caddy TLS proxy. Pulumi uses
the same conditional resource graph for the same domain/service configuration
in local and AWS environments. Floci's ALB data plane uses HTTP, even when an
HTTPS listener is modeled; it cannot prove real TLS, IAM isolation, public DNS,
or AWS networking enforcement. Those require real-AWS verification.

Local state lives in ignored `.floci/data`, `.pulumi/local`,
`infra/Pulumi.local.yaml`, and the owner-only `.floci/pulumi-passphrase`.
Retain them together. Do not delete volumes/state or run `pulumi destroy` as
a troubleshooting shortcut.

`aws:local:down` stops local runtime containers without deleting database
volumes. The launcher uses a replaceable `:local` image, a dedicated build
cache with a 2 GiB retention target, and scoped unused-image cleanup. It never
globally prunes Docker data. Image/cache size reports can share underlying
layers and should not simply be added together.

Local placeholder credentials allow infrastructure/boot tests only. They do
**not** enable real WorkOS login or LLM calls. Supply development credentials
through encrypted local Pulumi configuration and register
`http://localhost:8080/api/auth/callback` in the WorkOS development environment.
Do not put credentials in shell history, chat, source code, or Docker build args.

## Secrets and normal configuration

The encrypted Pulumi secret `databasePassword` creates the database URL secret.
The encrypted `runtimeSecrets` JSON object contains:

```text
WORKOS_API_KEY
WORKOS_CLIENT_ID
WORKOS_WEBHOOK_SECRET
OPENROUTER_API_KEY
LLMOXIE_API_KEY
SESSION_SECRET
ENCRYPTION_KEY
BLIND_INDEX_KEY
```

Use `pulumi config set --secret databasePassword --stack <stack>` for a
hidden interactive prompt. Load runtime JSON via secure stdin from an owner-only
file, not a command-line argument or checked-in plaintext file. Pulumi state
and stack configuration contain ciphertext; protect access to their backend.

ECS reads these values using the **execution role**, which has
`secretsmanager:GetSecretValue` for exactly those two secret ARNs. The app
receives normal environment variables and does not fetch the secrets itself.
The **task role** accesses S3 through the AWS SDK credential chain; production
has no static storage access keys. Production database connections verify the
RDS TLS certificate using the regional CA bundle included in the image.

`APP_URL`, `AWS_REGION`, `STORAGE_BUCKET`, `KNOWLEDGE_ROOT`, `PORT`
and `BUILD_SHA` are ordinary configuration. WorkOS builds the authorization
URL; its registered callback must be `${APP_URL}/api/auth/callback`.
Updating a secret does not update an already running process: replace/redeploy
the task after rotation.

## GitHub Actions: AWS releases only

`.github/workflows/test.yml` remains ordinary code CI. `release.yml` runs
build/tests and deploys to AWS, never Floci. Production runs only from release
tags (including manual dispatch on a tag) and uses a protected GitHub
`production` environment. Configure required reviewers and tag restrictions
in GitHub before enabling the first release.

Required GitHub configuration:

| Kind | Name | Value |
| --- | --- | --- |
| Environment secret | `PULUMI_ACCESS_TOKEN` | Access to the protected Pulumi Cloud stack. |
| Environment variable | `AWS_DEPLOY_ROLE_ARN` | ARN of the GitHub OIDC deployment role. |
| Environment variable | `PULUMI_STACK` | Fully qualified `organization/llteacher-infra/production`. |

No AWS access keys, database URL, WorkOS keys, provider keys or application
cryptographic keys belong in GitHub secrets. The separate test job uses
disposable PostgreSQL credentials and ephemeral test encryption keys.

The deployment job installs/builds Pulumi, refreshes encrypted Cloud stack
configuration, authenticates through GitHub OIDC, bootstraps ECR only if absent,
loads the test job's checksum-verified image artifact, publishes that same image
and resolves its digest. It previews/registers a
candidate while retaining the current service task definition, runs that exact
candidate as a one-off ECS migration, activates it only after success, waits
for stability and checks that health reports the expected commit. Failed
migration stops activation. Releases are serialized.

### One-time account/stack bootstrap (after explicit approval)

1. Create the account's GitHub OIDC provider for
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. Create a deployment role trusted only for that provider and subject
   `repo:uw-ssec/llteacher:environment:production`. GitHub's protected
   environment and tag restrictions are part of the authorization boundary.
3. Supply a reviewed deployment policy covering only the app's EC2 networking,
   ECS/ECR, RDS, S3, Secrets Manager, CloudWatch Logs, Route 53/ACM and IAM
   lifecycle operations. Scope concrete ARNs and `iam:PassRole` to
   `llteacher-production-*` execution/task roles and `ecs-tasks.amazonaws.com`.
   Some create/list/describe actions require wildcard resources; do not replace
   the policy review with AdministratorAccess. Restrict regional actions to
   us-west-2 while accommodating global IAM/Route 53 APIs.
4. Initialize/select `organization/llteacher-infra/production` in Pulumi Cloud.
   Set environment, region, bootstrap image tag and encrypted secrets, keeping
   `provisionService=false` and `deployApp=false` for base bootstrap.
   Save the initial stack/configuration in the backend before the workflow's
   `config refresh`. First-time bootstrap requires operator credentials and
   must not be attempted without approval.
5. Select a domain manually if HTTPS is required. Set `domainName`, apply
   zone/certificate/records, delegate the exported `hostedZoneNameServers`
   at the registrar, then set `domainReady=true` and apply validation/TLS.
   Domain purchase and registrar changes are not automated.
6. Review preview, cost, backup/deletion protection, OIDC policy, domain and
   WorkOS callbacks. Authorize the first tag release separately.

### Rollback and rotation

The workflow records the previous task-definition reference and image digest.
A code rollback can select the previous task definition after reviewing schema
compatibility; migrations are not automatically reversed. Never blindly roll
back across an incompatible migration. Keep the previous ECR image/task
definition available. A task replacement is required after secret rotation.

## Verification boundaries and deferred work

Run `npm run typecheck`, `npm test`, `npm run build`, infra mock tests,
and local shell contract tests. Database-gated tests need disposable pgvector
PostgreSQL; OKF integration tests need the pinned 0.3.0 binary. Local smoke
checks supplement tests, not real-AWS validation.

SQS workers, multi-task availability, scaling, full disaster recovery, data
migration/Django retirement, and production cutover remain deferred. See the
[M12 audit](../docs/superpowers/plans/2026-09-21-m12-infrastructure-milestone-audit.md).
Existing dependency-audit findings also need triage before a public release.
Never mark all Milestone 12 issues complete merely because this stack boots.
