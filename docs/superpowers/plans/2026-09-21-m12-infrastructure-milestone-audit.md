# M12 infrastructure milestone audit

**Audited:** 2026-09-21

**Repository revision:** [`0819f9c`](https://github.com/uw-ssec/llteacher/commit/0819f9c8dcf81bbaad1ad6e9bb990d12df956997)

**Milestone:** [M12: Infra, Migration & Cutover](https://github.com/uw-ssec/llteacher/milestone/12)

## Question and proposed architecture

This audit checks every issue currently assigned to M12 against the approved
production direction:

- ECS/Fargate in `us-west-2`, with the application task in public subnets and
  inbound traffic allowed only from an ALB;
- RDS PostgreSQL/pgvector in two private database subnets;
- one private S3 materials bucket;
- Secrets Manager for database and application secrets;
- Route 53 public hosted zone, ACM certificate, and an ALB alias after a domain
  is chosen; domain registration remains a manual business decision;
- no NAT Gateway;
- replace the dedicated overdue-job task with an in-process scheduler protected
  by a PostgreSQL advisory lock and startup catch-up;
- GitHub Actions deployments using AWS OIDC; and
- one Pulumi resource graph executed locally through Floci and in AWS for
  staging/production, with values and sizes varying by environment.

The milestone currently contains **19 issues: 14 open and 5 closed**. Issue
bodies, comments, and the milestone itself were read directly through GitHub on
the audit date. Repository references below are pinned to the revision above.

## Executive finding

The slim ECS/Fargate architecture is consistent with M12's top-level outcome
and its settled compute choice, but **it does not yet satisfy all of the written
M12 planning items**. There are four categories of discrepancy:

1. **Planning text that must be deliberately superseded.** Issues
   [#81](https://github.com/uw-ssec/llteacher/issues/81),
   [#82](https://github.com/uw-ssec/llteacher/issues/82), and
   [#63](https://github.com/uw-ssec/llteacher/issues/63) still require a static
   assets bucket plus CloudFront, although the repository's existing M12
   decision serves both frontends and the API from one same-origin ECS image.
   Retaining ALB delivery is the smaller and more coherent design, but the issue
   acceptance criteria must be amended before those issues can honestly close.
2. **Durable async ingestion is explicitly deferred from the September 30
   testing release.** #81 and [#40](https://github.com/uw-ssec/llteacher/issues/40)
   require SQS/worker infrastructure, but the release owner chose the smaller
   initial stack. Uploads continue through the existing in-process extraction
   queue. This supports low-volume testing but can lose pending work if the only
   ECS task restarts; failed or stranded uploads must be retryable from the UI.
   SQS remains a post-release hardening item rather than a completed M12 item.
3. **Production-readiness work was absent from the local brainstorm.** Backups,
   restore drills, Pulumi state protection, observability and alert delivery,
   rollback, staging refresh, full CI/E2E, data ETL, and Django retirement are
   all explicit M12 requirements. They do not necessarily add many always-on
   runtime resources, but they must be in the implementation/cutover plan.
4. **Two new M12 issues contradict the AWS decision.** Sandbox/setup issues
   [#455](https://github.com/uw-ssec/llteacher/issues/455) and
   [#456](https://github.com/uw-ssec/llteacher/issues/456) still mandate Neon.
   The M12 epic requires no Neon dependency. They should be rewritten to use
   the AWS staging RDS environment (and Floci for a contributor's local path),
   not implemented literally.

## Architecture decisions after the audit

| Area | Decision to carry into the plan | M12 effect |
| --- | --- | --- |
| Compute | Keep one ECS/Fargate service for the Node/Hono API and both SPA bundles. | Matches the Fargate direction in [#81](https://github.com/uw-ssec/llteacher/issues/81) and the Node runtime in [#82](https://github.com/uw-ssec/llteacher/issues/82). |
| Region | Parameterize the provider and all regional references; staging and production use `us-west-2`. Local Floci also declares `us-west-2` so AZ names and generated config are consistent. | Current code hard-codes `us-east-1` in [network.ts](https://github.com/uw-ssec/llteacher/blob/0819f9c8dcf81bbaad1ad6e9bb990d12df956997/infra/src/network.ts), [app.ts](https://github.com/uw-ssec/llteacher/blob/0819f9c8dcf81bbaad1ad6e9bb990d12df956997/infra/src/app.ts), [scheduled-job.ts](https://github.com/uw-ssec/llteacher/blob/0819f9c8dcf81bbaad1ad6e9bb990d12df956997/infra/src/scheduled-job.ts), and [release.yml](https://github.com/uw-ssec/llteacher/blob/0819f9c8dcf81bbaad1ad6e9bb990d12df956997/.github/workflows/release.yml). |
| Networking | Put the ALB and app task in the two public subnets; assign the task a public IP but allow inbound port 8080 only from the ALB security group. Keep RDS in two non-public subnets. Remove NAT, EIP, private app route table, and its associations. | #81 requires baseline networking, but does not require private application subnets or NAT. This is compliant and removes the largest avoidable fixed networking cost. |
| DNS/TLS | Pulumi creates a Route 53 public hosted zone, ACM DNS validation, and an alias to the ALB after `domainName` is supplied. Domain purchase/registration remains manual. Allow a pre-domain deployment mode that outputs the ALB DNS name and uses HTTP only for the temporary smoke test. | Adds a necessary implementation detail to #81/#63. A hosted zone does not itself register a domain, so the production gate must require registrar delegation before HTTPS launch. |
| Frontend delivery | Continue serving `/`, `/admin`, and `/api` from the single ECS image through the ALB. Do **not** create a static-assets bucket or CloudFront in this release. | Intentionally supersedes the CloudFront/static-bucket clauses in #81/#82/#63; update those issue bodies or add accepted decision comments before closure. The top-level [#66](https://github.com/uw-ssec/llteacher/issues/66) acceptance criteria do not require CloudFront. |
| Materials | Keep one private, versioned S3 bucket with lifecycle rules, deletion protection, and least-privilege task access. | Required by #81, #84, and first-release course-material uploads. Current [database.ts](https://github.com/uw-ssec/llteacher/blob/0819f9c8dcf81bbaad1ad6e9bb990d12df956997/infra/src/database.ts) creates the bucket and public-access block but not versioning/lifecycle protection. |
| Async ingestion | Do not create SQS, a DLQ, or a worker service for the September 30 testing release. Keep the current in-process extraction queue, expose failed/pending status and retry, and document restart-loss risk. | Explicitly defers the queue/worker clauses in #81 and [#40](https://github.com/uw-ssec/llteacher/issues/40); neither issue can close on this release. The queue is the first scale/reliability addition after testing demonstrates the need. |
| Scheduled work | Move only the existing overdue-submission sweep into the application process, using a PostgreSQL advisory lock, idempotent sweep, and startup catch-up. Do not represent an EventBridge resource locally if production has none. | This intentionally supersedes the current dedicated task in [scheduled-job.ts](https://github.com/uw-ssec/llteacher/blob/0819f9c8dcf81bbaad1ad6e9bb990d12df956997/infra/src/scheduled-job.ts). Future profile rebuild, retention, or roster schedules from other milestones need a fresh decision when those jobs ship; #81's blanket EventBridge requirement must be narrowed rather than silently marked complete. |
| Secrets | Keep at least two Secrets Manager secrets: database credentials/URL and structured application runtime secrets. Consolidating every value into one secret is not recommended because it expands IAM and rotation blast radius. Grant the ECS execution role `secretsmanager:GetSecretValue` and KMS decrypt access where applicable. | Satisfies #81/#82/#63 while repairing the current missing execution-role permission. Two logical secrets are still lightweight and preserve a useful least-privilege boundary. |
| Floci parity | Use one Pulumi program and the same AWS resource **types and topology** in local, staging, and production. Permit only documented environment-value differences such as sizing, retention/protection, credentials, and endpoint override. | This is stronger than #378 requires. However, [#378](https://github.com/uw-ssec/llteacher/issues/378) explicitly warns that emulator fidelity is not total and still requires real-AWS preview/validation. “Same graph” must not be presented as proof of AWS behavior. |
| State | Use local filesystem state for disposable Floci environments and a protected Pulumi Cloud organization for staging/production; document export/recovery. | Required by #81 and #84. Do not place production state in an unversioned local file. |

## Issue-by-issue audit

### Open issues

| Issue | Fit with the slim design | Required plan change or verification |
| --- | --- | --- |
| [#456 — WorkOS + Neon + LLM setup instructions](https://github.com/uw-ssec/llteacher/issues/456) | **Conflict.** Neon instructions contradict the no-Neon AWS target in #66/#82. | Rewrite acceptance criteria around WorkOS, Floci-local/RDS deployed database setup, Secrets Manager, and creation of an initial LLM configuration. Validate the README from a clean checkout. |
| [#455 — Neon sandbox](https://github.com/uw-ssec/llteacher/issues/455) | **Conflict.** A second Neon database would preserve the dependency M12 is removing. | Make the sandbox the AWS staging stack (RDS, ECS, S3, WorkOS sandbox organization), seed representative data, and document stakeholder access. If a cheaper temporary sandbox is desired, track it outside M12 rather than weakening production parity. |
| [#376 — invalid concurrent index recovery](https://github.com/uw-ssec/llteacher/issues/376) | **Missed.** Architecture-neutral but release-critical. | Teach the migration runner to detect `pg_index.indisvalid = false`, drop/rebuild the named index safely, document manual recovery, and add a pre-deploy/CI assertion that no invalid indexes remain. |
| [#163 — remove Neon HTTP driver](https://github.com/uw-ssec/llteacher/issues/163) | **Aligned, incomplete.** Long-lived Fargate supports a normal `pg` pool and needs no RDS Proxy. | Remove the Neon client/dependency and driver-adaptive `db.batch` branch, make node-postgres the only runtime client, size the pool against RDS `max_connections`, and run the gated real-Postgres suite. |
| [#97 — client error reporting](https://github.com/uw-ssec/llteacher/issues/97) | **Missed.** The proposed stack mentioned server logs but not browser failures. | Add error boundaries/reporting in both apps, a PII-minimized first-party endpoint, dedupe/sampling, commit-SHA stamping, CloudWatch metric/filter, and an actionable alarm destination. |
| [#84 — backup, restore, DR](https://github.com/uw-ssec/llteacher/issues/84) | **Partially aligned.** Current RDS code has seven-day backup retention and deletion protection outside local, but the full policy is absent. | Configure backup/maintenance windows and ≥7-day PITR; enable S3 versioning/lifecycle/protection; document Pulumi-state and key escrow recovery; write and execute the first restore/secrets drill in real AWS; assign the quarterly owner. Floci is useful rehearsal, not acceptance evidence. |
| [#83 — Playwright E2E](https://github.com/uw-ssec/llteacher/issues/83) | **Missed but compatible.** A deterministic mocked LLM is an application-test fixture, not a fake AWS resource graph. | Add student/instructor journeys, seeded DB, recorded auth/WebR choices, one retry maximum, failure artifacts, nightly staging execution, and a required release gate. Run the local suite against the exact Floci-provisioned stack. |
| [#82 — remove Cloudflare/Neon](https://github.com/uw-ssec/llteacher/issues/82) | **Mostly aligned, one written conflict.** Node/Fargate, `pg`, same-origin serving, and Secrets Manager align. Its S3+CloudFront frontend clause conflicts. | Complete removal of Cloudflare/Neon/wrangler paths and stale docs; verify SSE and pool behavior under concurrency; update the issue to recognize container-served assets through ALB and test both apps locally and in AWS staging. |
| [#81 — Pulumi AWS baseline](https://github.com/uw-ssec/llteacher/issues/81) | **Partially aligned.** Fargate, RDS/pgvector, S3 materials, secrets, ECR, IAM, logs, and OIDC align. CloudFront/static S3 removal and async/scheduler removal do not. | Record Fargate and same-origin ALB delivery in architecture docs; formally remove the static bucket/CloudFront requirement for this release; explicitly defer SQS ingestion, large-export workers, and future EventBridge jobs; add backup/versioning, state backend, OIDC, least-privilege checks, outputs, and clean previews for the stacks that are deployed. |
| [#66 — production-readiness epic](https://github.com/uw-ssec/llteacher/issues/66) | **Architecture aligned, milestone incomplete.** The epic requires much more than resource provisioning. | Preserve its dependency order: foundation → deploy/DR/E2E/observability → ETL → cutover/retirement. Add all later phases to the plan instead of treating a green Floci stack as milestone completion. |
| [#65 — Django retirement](https://github.com/uw-ssec/llteacher/issues/65) | **Outside the resource graph, still required.** | After the production TypeScript stack and ETL soak, tag the pre-removal release, create the agreed legacy branch/archive, remove Django CI/tooling, rewrite root docs, and decommission Coolify only after the soak window. |
| [#64 — Django→RDS ETL](https://github.com/uw-ssec/llteacher/issues/64) | **Outside the resource graph, still required.** | Build an idempotent/resumable encrypted ETL with UUID preservation and WorkOS identity bridge; execute a staging dry run; generate row/orphan/transcript verification; define freeze, abort, and DNS-flip criteria. Do not run production ETL during this infrastructure implementation. |
| [#63 — environments and deployment](https://github.com/uw-ssec/llteacher/issues/63) | **Partially aligned.** OIDC, immutable images, migration-before-compute, staging promotion, production approval, and smoke checks align. CloudFront and several operational gates were missed. | Replace the inaccessible hosted-runner `DATABASE_URL` model with a one-off ECS migration task inside the VPC; use Pulumi outputs; implement automatic staging deploy and protected production promotion of the same image digest; add expand/migrate/contract docs, rollback workflow and drill, sanitized staging refresh, alarms plus SNS destination, and smoke/version checks. Remove CloudFront steps when the issue is updated. |
| [#62 — full CI](https://github.com/uw-ssec/llteacher/issues/62) | **Missed.** The local AWS contract is additive, not a replacement for monorepo CI. | Add ESLint architectural restrictions, per-workspace typecheck/tests, full Turbo build, migration drift and collision checks, sensible path filters, parallel jobs, and bounded caching. |

### Closed issues that still constrain this work

| Issue | Consequence for the plan |
| --- | --- |
| [#378 — adopt Floci](https://github.com/uw-ssec/llteacher/issues/378) | Preserve the single endpoint override, pinned Floci release, persistent developer/disposable CI modes, end-to-end AWS integration test, documented unsupported behaviors, and a real-AWS preview/test gate. The approved exact-graph rule is compatible, but the issue explicitly rejects treating emulator success as AWS verification. |
| [#373 — migration numbering](https://github.com/uw-ssec/llteacher/issues/373) | Keep the PR-open-order numbering convention and `migration-index-collision` CI check when workflows are reorganized. |
| [#372 — concurrent indexes](https://github.com/uw-ssec/llteacher/issues/372) | Keep `CREATE INDEX CONCURRENTLY` outside Drizzle's transaction for hot tables. Its resolution directly leads to still-open #376's invalid-index recovery requirement. |
| [#179 — migrate before deploy](https://github.com/uw-ssec/llteacher/issues/179) | Preserve the hard gate: migration task succeeds before the ECS service revision starts. Add the still-requested greppable schema-behind log signature and rollout-order documentation. |
| [#148 — build/dry-run CI](https://github.com/uw-ssec/llteacher/issues/148) | Preserve explicit production builds, minimal workflow permissions, and concurrency cancellation. Replace the obsolete Wrangler dry run with Docker image build/boot plus Pulumi/Floci contract validation. |

## Required implementation-plan additions

The implementation plan should be split into gates. This keeps the immediate
resource cleanup manageable without falsely claiming all of M12 is complete.

### Gate 0 — reconcile the tracker before coding

1. Add decision comments to #81/#82/#63 (or edit their acceptance criteria) for
   same-origin ALB delivery with no CloudFront/static bucket.
2. Update #81/#40 to record that SQS ingestion, large-export workers, and
   future EventBridge jobs are deferred beyond the September 30 testing
   release rather than delivered by the initial stack.
3. Rewrite #455/#456 from Neon to AWS RDS/Floci.
4. Record Route 53/manual domain registration, `us-west-2`, no NAT, and the
   in-process overdue scheduler in the architecture decision log.

This audit does not mutate GitHub issues; those edits need a separate explicit
tracker update.

### Gate 1 — exact Pulumi topology and application dependencies

1. Refactor region/AZ/log settings to derive from provider/config and set all
   stack files/workflows to `us-west-2`.
2. Remove NAT/EIP/private app routing; point the ECS service at public subnets
   with `assignPublicIp: true`; keep RDS private.
3. Add Route 53 hosted-zone creation and optional pre-domain mode, then ACM
   validation and ALB alias when the registered domain is delegated.
4. Preserve one app ECR repository/service/task and one materials bucket; add
   bucket versioning/lifecycle/protection.
5. Keep separate database and runtime secrets; fix execution-role secret
   access; remove Neon code and dependencies.
6. Preserve the existing in-process course-material extraction path, add
   visible retry/recovery for stranded uploads, and document that an ECS
   restart can lose queued work until SQS is added later.
7. Replace only the overdue EventBridge task with the advisory-lock/catch-up
   application scheduler and verify idempotency/restart behavior.
8. Remove all topology branches that make local create a different set of AWS
   resource types. Document unavoidable value/behavior differences.

### Gate 2 — CI/CD and production safety

1. Complete #62 monorepo CI and #376 invalid-index checks.
2. On pull requests, build and boot the immutable image and deploy the same
   Pulumi graph to disposable Floci; smoke test the app, RDS/pgvector, S3,
   secrets, upload/retry flow, ALB routes, and scheduler behavior; always destroy the
   disposable stack and prune only CI-created image tags/caches.
3. Provision the GitHub OIDC provider/deploy role through Pulumi. Grant only
   ECR, ECS, Pulumi-managed infrastructure, migration task, and read-only output
   permissions needed by the workflow.
4. Build once and identify the image by digest. Deploy automatically to staging
   from the default deployment branch; promote that digest to production by a
   release tag or protected GitHub environment approval.
5. Run migrations as an ECS one-off task inside the target VPC. Stop before
   service update on failure. Wait for service stability, then run versioned
   health and smoke checks.
6. Add rollback and sanitized staging-refresh workflows/runbooks; exercise
   rollback once in staging.
7. Add server/client error, latency, and audit-write-failure metrics/alarms with
   an SNS destination and test delivery in staging.

### Gate 3 — real-AWS validation and operations

1. Run clean `pulumi preview` for staging and production in `us-west-2` without
   applying production. A real production `pulumi up` remains blocked on the
   user's separate explicit authorization.
2. Deploy staging, verify SSE, concurrent DB pooling, ingestion, WorkOS sandbox
   redirects, and both frontends.
3. Configure and document RDS/S3/Pulumi-state backups, key escrow, deletion
   protection, recovery, and execute the first real restore drill.
4. Run Playwright nightly on staging and as a release gate.

### Gate 4 — migration and cutover

1. Implement and verify #64 ETL against staging, including encrypted PII,
   WorkOS account claiming, row/orphan counts, and transcript rendering.
2. Approve the freeze/abort/DNS cutover plan; only then apply the production
   stack and migrate data under separate authorization.
3. After the soak period, execute #65: archive Django, decommission Coolify,
   and make TypeScript/AWS the repository's sole active path.

## Acceptance boundary

The immediate infrastructure branch can close the slim-topology portion of
#81/#82/#63, but it **cannot close M12 as a whole** until the deployment drills,
DR evidence, E2E, ETL, production cutover, and Django retirement gates are
complete. Likewise, an exact Floci resource graph is a valuable contract test,
not a substitute for the real-AWS previews and staging exercises explicitly
required by #378, #81, #84, and #66.
