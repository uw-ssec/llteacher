# M12: Infra, Migration & Cutover — milestone findings

**Checked:** 2026-09-15  
**Primary sources:** [M12 milestone](https://github.com/uw-ssec/llteacher/milestone/12) and [planning epic #66](https://github.com/uw-ssec/llteacher/issues/66).

## Decision register

| Decision | Status | Rationale |
| --- | --- | --- |
| Compute target | **Decided — ECS/Fargate, one full-app service** | Deploy one ECS/Fargate service that serves the student portal at `/`, the admin portal at `/admin`, and the shared web API. This avoids Lambda-specific changes to streamed chat responses, retains normal long-lived Postgres pooling, and keeps the deployment surface small. |
| Local AWS environment | **Decided — Floci only** | Local development and tests provision AWS-shaped resources against Floci. No real AWS resources are created during this phase. |
| Ingress routing | **Decided — one public HTTPS ALB with path routes** | Map `llteacher.local/` to the student portal and `llteacher.local/admin` to the admin portal through one target group. The local setup command installs or prints the required hosts-file entry and configures trusted local TLS; production uses ACM certificates. |
| App-service boundary | **Decided — one service, isolated application areas** | The admin portal calls the web app’s same-origin API. The existing route guards and role checks continue to isolate instructor/admin access from the student portal. One service is easier to build, deploy, observe, and maintain than two services while matching the current code’s actual boundary. |
| Local data lifetime | **Decided — persistent development, ephemeral tests** | Development keeps RDS, S3, queues, and scheduled-job state across restarts. The test command creates a fresh disposable Floci environment so tests remain isolated and repeatable. |
| Frontend delivery | **Decided — one service-owned container** | The ECS/Fargate service serves both built frontends from one image. S3 is private storage for course materials, rather than serving either SPA directly. |
| Large export storage | **Decided — deferred** | The current instructor export path returns bounded CSV/JSON directly to the browser. Do not provision an export bucket, signed-download flow, or export worker in the first local-AWS environment. Revisit these when asynchronous large exports are implemented under [#91](https://github.com/uw-ssec/llteacher/issues/91). |
| Existing scheduled behavior | **Decided — one minimal EventBridge job** | Preserve the existing hourly overdue-submission sweep with one EventBridge schedule that starts a short-lived ECS task. Do not add queues, generic workers, or other asynchronous infrastructure in this phase. |
| First local-AWS resource set | **Decided — approved minimum** | Provision Floci; networking (VPC, subnets, security groups, and production-equivalent egress); one public HTTPS ALB plus certificate; ECS cluster; one ECR repository; one long-lived task definition and Fargate service; one short-lived scheduled-task definition; RDS PostgreSQL with pgvector; one private course-materials bucket; Secrets Manager entries; CloudWatch log groups; and the single EventBridge schedule. Defer CloudFront, SQS/worker tasks, export storage, GitHub OIDC, and backup/DR policy. |
| Runtime architecture | **Decided — one Node container plus scheduled command** | A Node 24 Hono server serves the web bundle at `/`, the admin bundle at `/admin`, and `/api/*` from the same container. It uses a typed process-environment configuration and a `pg` pool against RDS. The same image exposes a short-lived overdue-submission command for EventBridge. |
| Pulumi state | **Decided — local filesystem; Pulumi Cloud for AWS** | Local development and CI use a filesystem state backend and never require an account. Future staging and production use Pulumi Cloud for durable state, while GitHub OIDC authenticates only the real-AWS deployment. |

## App-service topology options

| Option | Benefits | Costs | Fit |
| --- | --- | --- | --- |
| **Two independent services** | Separate images, deployments, scaling, logs, and blast radius; each hostname maps to an explicit service; preserves an eventual independently evolving admin backend. | Two ECR repositories, task definitions, ECS services, target groups, health checks, deployment paths, and the public HTTPS admin-to-web proxy. The admin is currently a static SPA and has no distinct API, so the extra service boundary is operational rather than domain-driven today. | Revisit only if the admin gains a separate backend or independent scaling/deployment becomes necessary. |
| **One full-app service with two routes** | One image, task definition, ECS service, target group, deployment, health check, and database connection pool; no inter-service proxy. Route `/` serves the student app and `/admin` serves the admin SPA; API remains same-origin. Easier to build, deploy, observe, and maintain while relying on the existing role and route guards for application-level isolation. | Web and admin scale and deploy together; a failure or rollout affects both; no separate runtime boundary if the admin later gains a backend. | **Selected.** Best for the current codebase, where the admin is a frontend that consumes the web app’s API. |

The two-service design’s added complexity is therefore a conscious trade-off for independent operation, not a requirement imposed by Floci or Pulumi. The first local-AWS implementation selects the single-service design.

## Access and status

The public GitHub milestone and issue are accessible. M12 is **open**, due
2026-09-17, with **16 open and 3 closed issues** (15% complete). Its stated
outcome is AWS production readiness: Pulumi-managed RDS Postgres with pgvector,
S3, and Secrets Manager; removal of Cloudflare/Neon; CI/E2E and deployment;
SQLite-to-Postgres migration; and Django retirement. [Milestone](https://github.com/uw-ssec/llteacher/milestone/12)

Open M12 issues: [#456](https://github.com/uw-ssec/llteacher/issues/456),
[#455](https://github.com/uw-ssec/llteacher/issues/455),
[#378](https://github.com/uw-ssec/llteacher/issues/378) (Floci local/CI AWS),
[#376](https://github.com/uw-ssec/llteacher/issues/376),
[#179](https://github.com/uw-ssec/llteacher/issues/179),
[#163](https://github.com/uw-ssec/llteacher/issues/163),
[#97](https://github.com/uw-ssec/llteacher/issues/97),
[#84](https://github.com/uw-ssec/llteacher/issues/84),
[#83](https://github.com/uw-ssec/llteacher/issues/83),
[#82](https://github.com/uw-ssec/llteacher/issues/82),
[#81](https://github.com/uw-ssec/llteacher/issues/81),
[#66](https://github.com/uw-ssec/llteacher/issues/66),
[#65](https://github.com/uw-ssec/llteacher/issues/65),
[#64](https://github.com/uw-ssec/llteacher/issues/64),
[#63](https://github.com/uw-ssec/llteacher/issues/63), and
[#62](https://github.com/uw-ssec/llteacher/issues/62). Closed: [#373](https://github.com/uw-ssec/llteacher/issues/373),
[#372](https://github.com/uw-ssec/llteacher/issues/372), and [#148](https://github.com/uw-ssec/llteacher/issues/148).

## Planning epic #66: dependency order

Epic [#66](https://github.com/uw-ssec/llteacher/issues/66) is open and shows
0/9 child issues completed. Its ordering is deliberately phased:

1. **Foundation:** Complete [#81](https://github.com/uw-ssec/llteacher/issues/81)
   (Pulumi AWS baseline) first; it blocks the later phases. Then complete
   [#82](https://github.com/uw-ssec/llteacher/issues/82) (remove
   Cloudflare/Neon runtime dependencies), which blocks [#63](https://github.com/uw-ssec/llteacher/issues/63).
   [#62](https://github.com/uw-ssec/llteacher/issues/62) (full-workspace CI)
   can run in parallel, but is the confidence gate for subsequent PRs.
2. **Safe deployment and observability:** [#63](https://github.com/uw-ssec/llteacher/issues/63)
   requires #81 and #82. [#84](https://github.com/uw-ssec/llteacher/issues/84)
   requires #81 only; [#83](https://github.com/uw-ssec/llteacher/issues/83)
   requires #62 and is independent of #63; and
   [#97](https://github.com/uw-ssec/llteacher/issues/97) requires #81's
   CloudWatch foundation.
3. **Cutover:** [#64](https://github.com/uw-ssec/llteacher/issues/64) requires
   RDS from #81 and stable CI/deploy from #62/#63. Its staging dry run is an
   explicit, non-negotiable gate. Execute [#65](https://github.com/uw-ssec/llteacher/issues/65)
   only after that migration is verified and the TypeScript production stack
   has soaked.

## Local-first AWS implication

[#378](https://github.com/uw-ssec/llteacher/issues/378), “adopt Floci as the
local and CI AWS environment,” is open in M12 but is **not** one of #66's nine
children. It calls for a local endpoint override, pinned image, local-persistent
and CI-ephemeral modes, integration coverage, a Pulumi compatibility check (or
documented limits), and a clear real-AWS boundary. It supports treating Floci as
the local/CI implementation path for #81's AWS baseline while preserving #66's
ordering: establish the AWS-shaped foundation before re-platforming, deployment,
migration, and retirement. This relationship is an inference from the issues;
#66 does not explicitly add #378 as a dependency.

Before starting #81, its issue explicitly asks us to inspect existing branch
`ksdani/add-initial-pulumi-infra` to avoid duplicating work. [#81](https://github.com/uw-ssec/llteacher/issues/81)
