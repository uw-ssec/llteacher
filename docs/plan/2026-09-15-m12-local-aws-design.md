# M12 Local AWS Design

## Goal

Run the complete TypeScript LLTeacher application locally against AWS-shaped
resources emulated by Floci. The same Pulumi program must later support
staging and production stacks in the verified AWS account without changing the
application topology.

## Scope

This design implements the local-first foundation for M12 issues #81, #82,
#179, #163, #376, and #378. It preserves the existing hourly overdue-section
submission behavior. It does not implement CloudFront, asynchronous workers,
export artifact storage, GitHub OIDC, production backup/DR, ETL/cutover, or
Django retirement.

## Architecture

One Node 24 container runs as one ECS/Fargate service. It serves the student
SPA at `/`, the instructor/admin SPA at `/admin`, and the Hono API below
`/api/*`. The existing application role and route guards remain the isolation
boundary between student and instructor functionality. The admin SPA therefore
uses the same-origin API without a proxy or cross-origin browser requests.

The service is reached through one public HTTPS ALB. Locally the host is
`llteacher.local`; the setup command installs or prints the required hosts-file
entry and configures a trusted `mkcert` development certificate. Production
uses an ACM certificate for the real domain.

The Node server replaces the Cloudflare Worker entry. It receives a typed
runtime configuration sourced from process environment variables. It creates a
bounded `pg` pool for RDS/Postgres and owns static-file fallback for both SPA
build directories. The existing job implementation is exposed through a
short-lived command in the same image; a single EventBridge schedule launches
that command hourly.

## Local AWS resources

- Floci with persistent development state and a fully disposable test mode.
- VPC, subnets, security groups, and production-equivalent egress.
- HTTPS ALB and one target group for the app service.
- ECS cluster, one ECR repository, one long-lived service task definition,
  and one short-lived scheduled-job task definition.
- RDS PostgreSQL with the `pgvector` extension.
- One private S3 bucket for course materials.
- Secrets Manager entries for database, WorkOS, LLM/provider, and encryption
  keys.
- CloudWatch log groups.
- One EventBridge schedule for the existing overdue-submission sweep.

Deferred resources: CloudFront, generic queues/workers, export artifact
storage, GitHub OIDC, and production backup/DR.

## Pulumi stacks and deployments

The local and CI path uses Pulumi with a filesystem state backend and points
the AWS provider to Floci. It never requires AWS credentials or creates cloud
resources. Future staging and production stacks use Pulumi Cloud for state;
GitHub Actions obtains AWS deployment credentials via GitHub OIDC.

The deployment order is invariant: provision or update infrastructure, build
and publish the image, run database migrations as a one-off task, then update
the long-lived ECS service and wait for its health check. The service is never
updated if migrations fail.

## Commands and safety

The delivered command surface will be:

- `npm run aws:local:up` — start persistent Floci, apply Pulumi, build and
  publish the image, migrate, deploy, and wait for HTTPS health checks.
- `npm run aws:local:test` — create a disposable Floci environment, apply the
  stack, and run integration smoke tests.
- `npm run aws:local:down` — remove only local Floci state and containers.

Commands fail before a deployment on missing prerequisites, a failed Pulumi
apply, failed image publish, failed migration, or an unhealthy ECS service.
They never echo secret values, and the teardown command cannot target real AWS.

## Verification

Test-first implementation covers Node adaptation, static routing (`/` and
`/admin`), process-environment configuration, `pg` connectivity, the scheduled
job command, and deployment-script failure behavior. The local integration
suite verifies the HTTPS student and admin routes, `/api/health`, migrations,
and a streamed chat response using a test provider. It also confirms that the
deployment script runs migrations before updating the service.

## Future production path

Floci is only for local development and disposable CI validation. Production
deployment uses the same Pulumi code against the verified AWS account. A later
Cloudflare Workers migration remains feasible but is a separate replatforming:
it would replace the ECS/RDS/S3/EventBridge integrations with Cloudflare
equivalents or cross-cloud adapters.
