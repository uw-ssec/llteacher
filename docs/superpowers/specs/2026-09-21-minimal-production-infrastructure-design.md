# Minimal production infrastructure design

Backend decision updated by the [2026-09-22 S3 backend design](2026-09-22-s3-pulumi-backend-design.md).
Use stack `production`, bucket `llteacher-pulumi-state-055237683908-us-west-2`,
backend `s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra`, and
KMS alias `alias/llteacher-pulumi-state`. The GitHub OIDC subject is exactly
`repo:uw-ssec/llteacher:environment:production`. Follow the current
[bootstrap procedure](../../../infra/README.md#one-time-accountstack-bootstrap-after-explicit-approval).

Approved interactively on 2026-09-21 for the September 30 production testing
release. This design narrows the work from completing all of Milestone 12 to
deploying a small, maintainable AWS application stack that can be exercised
locally through Floci before any real production resources are created.

## Goals

- Run the existing Node/Hono application and both SPAs in one ECS/Fargate task.
- Run PostgreSQL with pgvector on RDS.
- Store course-material originals in one private S3 bucket.
- Store database and application secrets in Secrets Manager.
- Expose one HTTPS application origin through an ALB, ACM, and Route 53.
- Put every regional AWS resource in `us-west-2`.
- Build, test, migrate, and deploy immutable releases through GitHub Actions
  using AWS OIDC; GitHub Actions never runs the local Floci deployment.
- Use the same Pulumi application resource types and topology in Floci and AWS.
- Stop the local workflow from accumulating timestamped images and stale RDS
  volumes.

## Release boundary

This is a production-capable testing release, not completion of M12. The
following work is explicitly deferred:

- SQS ingestion and export queues, DLQs, and separate worker services;
- CloudFront and a separate static-assets bucket;
- generic EventBridge schedules and separate scheduled ECS tasks;
- multi-AZ RDS, ECS autoscaling, WAF, Redis, and other scale infrastructure;
- production data ETL, DNS cutover, Django retirement, and Coolify shutdown;
- full disaster-recovery and production cutover drills; and
- creation of real production AWS resources without a later explicit approval.

Course uploads remain available in the first release. Extraction uses the
existing in-process queue. A restart can lose pending in-memory work, so the UI
must continue to expose `pending`/`failed` states and allow retry. SQS is the
first post-release reliability addition if testing shows that this trade-off is
unacceptable.

## Decisions

### Compute

Use one ECS/Fargate service with desired count one. The container serves the
student SPA at `/`, the admin SPA at `/admin`, and the API under `/api`. This
keeps one origin, avoids CORS and CDN invalidation, preserves SSE streaming,
and requires no server operating-system maintenance.

For this single-process release, replacement stops the old app task before
starting its successor (`minimumHealthyPercent: 0`, `maximumPercent: 100`).
This introduces brief deployment downtime but avoids simultaneous extraction
recovery and filesystem writers. Migrations run while the existing task is
still serving; only successful migrations permit that replacement.

The ECS task also runs two low-volume background loops:

- the existing course-material extraction queue; and
- the overdue-submission sweep, run hourly and once after startup.

The overdue sweep must use a PostgreSQL advisory lock and retain its existing
idempotency so a future scale-out cannot submit work twice. Moving it into the
application removes the EventBridge rule, target, scheduler role/policy,
scheduled task definition, scheduled-job log group, SQS DLQ, queue policy, and
ineffective DLQ alarm.

### Networking

Create one VPC spanning `us-west-2a` and `us-west-2b`:

- two public subnets contain the ALB and the Fargate task;
- the Fargate task receives a public IP for direct outbound access to WorkOS,
  OpenRouter, and other public APIs;
- its security group accepts port 8080 only from the ALB security group;
- two non-public subnets contain RDS; and
- the RDS security group accepts PostgreSQL only from the application security
  group.

There is no NAT Gateway, NAT Elastic IP, application-private route table, or
application-private subnet. A public task IP does not make the application
port public because its security group has no internet ingress rule.

### DNS and TLS

Use a Pulumi-managed Route 53 public hosted zone, DNS-validated regional ACM
certificate, and Route 53 alias from the selected application domain to the
ALB. Domain purchase and registrar ownership are manual business decisions and
are not performed by Pulumi.

`domainName` remains a pending production deployment input. Before the domain
is selected, the ALB-generated hostname may be used for an HTTP smoke test.
Production launch requires registrar delegation to the hosted zone and a
successfully validated HTTPS listener.

DNS setup is staged: supplying `domainName` creates the zone, certificate,
validation record, and alias; enabling `domainReady` after registrar delegation
waits for certificate validation and enables HTTPS. Without a domain the stack
exposes an HTTP bootstrap endpoint. This is not approval to launch authenticated
production traffic without TLS. Each mode has the same graph in Floci and AWS.

Route 53 and IAM are global services. All resources that have an AWS region,
including ACM for the ALB, use `us-west-2`.

### Data and secrets

RDS uses PostgreSQL 16, pgvector bootstrap/migrations, encrypted 20 GiB storage,
seven-day automated backup retention, deletion protection, and a final
snapshot in production. The initial instance remains a modest burstable class
appropriate for testing.

The materials bucket is private and receives public-access blocking,
versioning, a documented noncurrent-version lifecycle, encryption, and Pulumi
protection in production. The application task receives only the object/list
permissions it uses.

The same bucket also stores durable per-course knowledge snapshots, including
Markdown and pre-edit originals. OKF operates on a temporary local working
copy restored on first use. Mutations complete only after the snapshot is
stored; failed writes restore the last durable state. Per-course operations
are serialized inside the single app process. This avoids an extra EFS
filesystem, mount targets and security group, at the cost of snapshot I/O and
the single-writer deployment constraint. Multi-task scaling is deferred.

Keep two Secrets Manager secrets:

1. the generated database connection value; and
2. structured application runtime values such as WorkOS, LLM-provider,
   session, encryption, blind-index, and webhook keys.

The separation costs one extra secret/version pair but keeps database rotation
and application-key rotation independent. The ECS execution role receives
`secretsmanager:GetSecretValue` for exactly these secrets. The task role keeps
only runtime S3 permissions.

At container startup, ECS uses the execution role to resolve the secret ARNs
listed in the task definition and injects their JSON keys as environment
variables. Application code continues to read `DATABASE_URL`,
`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_WEBHOOK_SECRET`, provider keys,
and application cryptographic keys from `process.env`. Updating a secret
requires a new ECS deployment so replacement tasks receive the new value.

Application secrets are not copied into GitHub repository or environment
secrets. They are entered during the one-time stack bootstrap as encrypted
Pulumi stack configuration and materialized into AWS Secrets Manager. The S3
backend uses the dedicated KMS key for state encryption and Pulumi secrets.
GitHub environment variables `AWS_DEPLOY_ROLE_ARN`, `PULUMI_BACKEND_URL`, and
`PULUMI_STACK=production` are non-secret identifiers. AWS access uses GitHub
OIDC and short-lived credentials; no Pulumi access token or AWS access key is
stored in GitHub.

`APP_URL`, `STORAGE_BUCKET`, the AWS region, and the application port are
ordinary task environment values. WorkOS's authorization URL is generated by
the WorkOS SDK. The application derives its callback as
`${APP_URL}/api/auth/callback`, and that same public URI must be registered in
the WorkOS dashboard.

### Application-stack resource inventory

The final domain-enabled stack declares the following AWS resources. Local,
staging if later enabled, and production use the same resource types and
relationships; only values such as endpoint, credentials, protection,
retention, image tag, domain, and instance size may differ.

| Area | Resources | Why they remain |
| --- | --- | --- |
| Network | 1 VPC, 1 internet gateway, 1 public route table, 2 public subnets, 2 route-table associations, 2 private DB subnets | ALB requires two AZs; RDS subnet groups require two AZs; the task needs outbound internet without NAT. |
| Security | ALB, application, and database security groups | Enforce internet → ALB → app → database and nothing broader. |
| Database | 1 DB subnet group and 1 RDS instance | Managed PostgreSQL/pgvector with backups and deletion protection. |
| Storage | 1 S3 bucket, public-access block, versioning configuration, lifecycle configuration | Store course uploads privately and recover accidental overwrites/deletes. |
| Secrets | 2 secrets and 2 secret versions | Separate database rotation from application-key rotation. |
| Compute | 1 ECR repository, ECS cluster, task definition, and service | Store and run one immutable application image without managing a host. |
| Identity | ECS execution role, task role, managed execution-policy attachment, scoped secret policy, scoped S3 policy | Permit image pulls/logging/secret injection and application S3 access without broad credentials. |
| Logging | 1 CloudWatch application log group | Central logs with bounded retention. |
| Ingress | 1 ALB, target group, HTTPS listener, ACM certificate, certificate validation, Route 53 hosted zone, validation record, and ALB alias | Stable custom origin, TLS, health checks, and task replacement without DNS changes. |

This is approximately 40 declared application-stack resources. Most are
zero-cost control-plane objects. The meaningful recurring cost centers are the
ALB, one Fargate task, and one RDS instance. Removing the NAT Gateway and the
separate scheduled task eliminates the largest avoidable fixed/runtime costs.

The state bucket, KMS key/alias, account-wide GitHub OIDC provider, deployment
role, three scoped managed deployment policies, and managed runtime permissions
boundary are account bootstrap resources, not application-stack resources.
The boundary is created before production runtime roles; existing execution/task
roles must carry that exact boundary before deployment access is enabled.
They are created once in the AWS account and documented separately. Floci validates
the application stack; GitHub/AWS federation is validated by the protected
production deployment workflow.

## Exact Floci parity contract

One TypeScript Pulumi program creates the application stack. The local stack
may not substitute Docker Compose Postgres, a directly launched application
container, or another fake service for an AWS resource. Floci must create and
run the RDS- and ECS-backed containers.

Allowed local differences are values, not topology:

- AWS provider service endpoints point to Floci;
- credentials are non-production local values;
- destructive protection and backup retention are relaxed for the developer-local stack;
- resource sizes and image tags may be smaller/local; and
- a local domain or host mapping replaces public registrar delegation.

There are unavoidable emulator behavior limits. Floci 2.1.0 records an HTTPS
ALB listener but its ELBv2 data plane opens a plain HTTP listener socket, and
its Route 53 control plane does not become authoritative public DNS. Local
tests therefore reach the Floci ALB socket directly and use a host mapping when
needed. No Caddy container or Docker-launched app/database replaces an AWS
resource in the parity test. HTTPS termination and public DNS are verified in
real AWS before launch.

Floci success proves that the Pulumi graph and supported integration paths are
coherent. It does not replace a real-AWS preview and deployment smoke test.

## Application changes

- Derive AWS region and availability zones from configuration; remove every
  hard-coded `us-east-1` reference.
- Add the ECS execution-role permission required to retrieve both secrets.
- Add the missing Route 53 alias from the application domain to the ALB.
- Make node-postgres the only deployed database driver and remove remaining
  Neon/Cloudflare runtime assumptions that affect the AWS image.
- Run the overdue sweep in-process with startup catch-up, hourly cadence,
  advisory locking, clean shutdown, and focused tests.
- Keep course extraction in-process for this release and verify failed/pending
  recovery and retry behavior.
- Persist knowledge files in the existing S3 bucket so replacing a task does
  not lose authored/extracted content or pre-edit originals.
- Preserve migration-before-deploy and add invalid concurrent-index detection
  so a failed index build cannot be mistaken for success on the next release.
- Expose a versioned health response suitable for deployment verification.

## Local Floci workflow

Floci runs only on a developer workstation through repository commands such as
`npm run aws:local:up`, `npm run aws:local:verify`, and
`npm run aws:local:down`. The repository does not start Floci or apply a local
Pulumi stack from GitHub Actions. The existing `local-aws.yml` workflow is
removed.

The local command builds the production Dockerfile, applies the Pulumi local
stack to Floci in `us-west-2`, runs migrations, and smoke-tests RDS/pgvector,
Secrets Manager injection, S3 upload/read, ALB routing, course-material retry,
and the overdue scheduler. This is the developer's pre-release infrastructure
check.

## GitHub Actions release

Production deployment remains disabled until separately authorized.
After authorization, one protected release workflow performs:

1. check out the selected release tag or commit;
2. install dependencies, lint, typecheck, run tests, build all workspaces, and
   build the production Docker image;
3. authenticate to AWS with GitHub OIDC and short-lived credentials;
4. on the first release only, bootstrap base Pulumi resources, including ECR,
   in `us-west-2` without starting an unavailable image; preserve any existing
   service on subsequent releases;
5. push the commit-SHA image to ECR and resolve its immutable digest;
6. run `pulumi preview` for the production stack using that digest;
7. create the candidate task definition while pinning an existing service to
   its current task definition (or keeping the service absent on first release);
8. run migrations as a one-off ECS task inside the VPC;
9. stop immediately if migration or invalid-index validation fails;
10. update the ECS service to the exact tested image digest;
11. wait for service stability and verify health/version through the ALB; and
12. retain the prior task definition/image digest for rollback.

The deployment job never receives a long-lived AWS access key or a plaintext
production database URL. The separate test job uses a disposable PostgreSQL
service with test-only credentials. Pulumi state for AWS uses a protected
shared backend; developer-local Floci uses filesystem state.

## Local disk discipline

The observed 37 GiB was primarily accumulated Docker images/build cache, not
40 AWS resources consuming independent disks. The existing script creates a
new `local-<timestamp>` image on every run and never removes the old tag; the
current Dockerfile also copies a large dependency tree into the runtime image.

The implementation must:

- use one replaceable local tag or deterministic content tag;
- remove only superseded LLTeacher local tags after a successful deployment;
- use a smaller multi-stage runtime image and omit build-only dependencies;
- use one persistent developer-local RDS volume; no Floci deployment runs in CI;
- provide a scoped cleanup command that lists what it will remove and never
  prunes unrelated Docker images, volumes, or caches; and
- report image/cache/volume usage after local deployment.

## Verification and release gates

- Pulumi mock tests assert the exact resource graph and absence of NAT,
  EventBridge, SQS, CloudFront, and separate worker/scheduled services.
- Local and production configuration tests assert `us-west-2` and reject real
  AWS endpoints in the local stack.
- Security tests assert ALB-only application ingress, app-only database
  ingress, private RDS, private S3, scoped secret access, and no wildcard IAM
  actions/resources where a concrete ARN is available.
- Scheduler tests cover one-run-on-startup, hourly invocation, advisory-lock
  contention, idempotency, and shutdown.
- Workflow tests prove the AWS release runs build/test before deployment,
  contains no Floci command or endpoint, completes migrations before service
  update, and retains an existing immutable digest for rollback.
- A developer-local Floci run must boot the exact application stack and pass
  smoke tests before the branch is handed back for local testing.
- Before a real `pulumi up`, AWS preview output, expected monthly cost, domain
  readiness, secret values, backup settings, and deployment-role permissions
  are reviewed with the release owner.

## Milestone 12 relationship

The accompanying
[`2026-09-21-m12-infrastructure-milestone-audit.md`](../plans/2026-09-21-m12-infrastructure-milestone-audit.md)
maps all 19 milestone issues. This release implements only the subset required
to put a productionized application online for testing. Deferred acceptance
criteria remain open and must not be marked complete merely because this stack
deploys successfully.
