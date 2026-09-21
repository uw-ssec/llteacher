# Minimal production infrastructure design

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
- Deploy immutable images only through GitHub Actions using AWS OIDC.
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

Keep two Secrets Manager secrets:

1. the generated database connection value; and
2. structured application runtime values such as WorkOS, LLM-provider,
   session, encryption, blind-index, and webhook keys.

The separation costs one extra secret/version pair but keeps database rotation
and application-key rotation independent. The ECS execution role receives
`secretsmanager:GetSecretValue` for exactly these secrets. The task role keeps
only runtime S3 permissions.

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

The GitHub OIDC provider, deployment role, and scoped deployment policy are
account bootstrap resources, not per-environment application resources. They
are created once in the AWS account and documented separately. Floci validates
the application stack; GitHub/AWS federation is validated by the staging or
production deployment workflow.

## Exact Floci parity contract

One TypeScript Pulumi program creates the application stack. The local stack
may not substitute Docker Compose Postgres, a directly launched application
container, or another fake service for an AWS resource. Floci must create and
run the RDS- and ECS-backed containers.

Allowed local differences are values, not topology:

- AWS provider service endpoints point to Floci;
- credentials are non-production local values;
- destructive protection and backup retention are relaxed for disposable CI;
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
- Preserve migration-before-deploy and add invalid concurrent-index detection
  so a failed index build cannot be mistaken for success on the next release.
- Expose a versioned health response suitable for deployment verification.

## GitHub Actions delivery

### Pull requests

1. Install dependencies, lint, typecheck, test, and build the workspaces.
2. Build the production Dockerfile and tag the image with a stable local tag or
   content identifier rather than a timestamp.
3. Start a disposable pinned Floci instance.
4. Apply the local Pulumi stack in `us-west-2` with no real AWS credentials.
5. Run migrations and smoke-test RDS/pgvector, Secrets Manager injection, S3
   upload/read, ALB routing, course-material retry, and the overdue scheduler.
6. Destroy only the disposable CI stack and upload failure diagnostics.

### Production release

Production deployment remains disabled until separately authorized.
After authorization, a protected GitHub environment performs:

1. authenticate to AWS with GitHub OIDC and short-lived credentials;
2. build once, push the commit-SHA image to ECR, and capture its digest;
3. run `pulumi preview` for the production stack in `us-west-2`;
4. update infrastructure/task definition without starting the new service;
5. run migrations as a one-off ECS task inside the VPC;
6. stop immediately if migration or invalid-index validation fails;
7. update the ECS service to the exact tested image digest;
8. wait for service stability and verify health/version through the ALB; and
9. retain the prior task definition/image digest for rollback.

The workflow never receives a long-lived AWS access key or a plaintext
database URL. Pulumi state for AWS uses a protected shared backend; local and
CI Floci stacks use filesystem state.

## Local disk discipline

The observed 37 GiB was primarily accumulated Docker images/build cache, not
40 AWS resources consuming independent disks. The existing script creates a
new `local-<timestamp>` image on every run and never removes the old tag; the
current Dockerfile also copies a large dependency tree into the runtime image.

The implementation must:

- use one replaceable local tag or deterministic content tag;
- remove only superseded LLTeacher local tags after a successful deployment;
- use a smaller multi-stage runtime image and omit build-only dependencies;
- use disposable Floci storage in CI and one named/persistent local RDS volume;
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
- Deployment tests prove migrations finish before service update and rollback
  selects an existing immutable digest.
- A disposable Floci run must boot the exact application stack and pass smoke
  tests before the branch is handed back for local testing.
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
