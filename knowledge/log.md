## 2026-10-08
* **Update**: Linked `bugs/hint-test-initial-hydration-race.md` to `bugs/chat-rerender-per-token.md` (Both depend on the lifecycle and rendering of the real streaming chat surface.).
* **Creation**: Documented concept `bugs/hint-test-initial-hydration-race.md` (Hint suppression tests must wait for initial history).
* **Update**: Updated concept `facts/code-typescript-and-install.md`.
* **Update**: Updated concept `facts/authority-and-provisioning-gaps.md`.
* **Update**: Linked `decisions/course-membership-roles.md` to `decisions/org-admin-role-and-course-scoped-configs.md` (Adds the first organization-level role beside course roles).
* **Update**: Linked `facts/authority-and-provisioning-gaps.md` to `decisions/org-admin-role-and-course-scoped-configs.md` (#367 closed the org-level LLM config gap with an Org Admin role).
* **Creation**: Documented concept `decisions/org-admin-role-and-course-scoped-configs.md` (Org Admin owns the shared LLM config pool; course instructors own course-scoped configs).
* **Update**: Linked `decisions/effect-typed-request-pipeline.md` to `bugs/partial-stream-persisted-as-complete.md` (Same chat turn-finalization path: the Effect migration found that a provider rejection before any stream existed left the turn unfinalized and its lock held, returning false 409 in_progress on retry.).
* **Creation**: Documented concept `decisions/effect-typed-request-pipeline.md` (API handlers run as Effect 4 programs with typed errors).

## 2026-10-07
* **Update**: Linked `decisions/design-system-lint.md` to `architecture/system-overview.md` (The shared UI package and two clients are governed by this design-system lint policy.).
* **Update**: Updated concept `decisions/design-system-lint.md`.
* **Update**: Linked `decisions/design-system-lint.md` to `architecture/system-overview.md` (The shared UI package and two clients are governed by this design-system lint policy.).
* **Creation**: Documented concept `decisions/design-system-lint.md` (ShadCN lint enforces the shared UW design system).

## 2026-10-06
* **Update**: Updated concept `decisions/project-template-adoption.md`.
* **Update**: Updated concept `architecture/skill-evals.md`.
* **Update**: Updated concept `facts/code-turbo-evals-typecheck-race.md`.
* **Update**: Linked `architecture/skill-evals.md` to `architecture/eval-harness.md` (Not to be confused with the product's tutor eval).
* **Update**: Linked `architecture/skill-evals.md` to `facts/skill-evals-authoring-lessons.md` (Rules for writing its verifiers and samples).
* **Update**: Linked `decisions/project-template-adoption.md` to `architecture/skill-evals.md` (The skill-eval layer the template adoption added).
* **Update**: Linked `facts/stale-root-claude-md.md` to `decisions/project-template-adoption.md` (Resolved by the template adoption).
* **Update**: Linked `architecture/ci-release-pipeline.md` to `facts/eleven-dimension-review-process.md` (The review process around PRs).
* **Update**: Linked `architecture/ci-release-pipeline.md` to `facts/code-db-tests-skip-without-database-url.md` (What CI's Postgres service enables that local runs skip).
* **Update**: Linked `architecture/system-overview.md` to `architecture/infra-topology.md` (Where the system runs).
* **Update**: Linked `architecture/system-overview.md` to `architecture/request-path.md` (Entry point of a request).
* **Update**: Linked `architecture/eval-harness.md` to `requirements/stakeholder-knowledge-gap-insight.md` (Insight into student gaps is a stated need the evals do not cover yet).
* **Update**: Linked `architecture/llm-tutor-pipeline.md` to `bugs/chat-rerender-per-token.md` (A client rendering bug in streaming).
* **Update**: Linked `architecture/llm-tutor-pipeline.md` to `bugs/client-history-system-message-injection.md` (A prompt-injection hole in client history).
* **Update**: Linked `facts/code-migrate-runner-split-and-concurrently.md` to `bugs/invalid-concurrent-index-skipped.md` (An interrupted CONCURRENTLY build).
* **Update**: Linked `requirements/migrate-before-deploy.md` to `facts/migration-index-collision-convention.md` (Numbering rules for the migrations being applied).
* **Update**: Linked `requirements/migrate-before-deploy.md` to `facts/code-migrate-runner-split-and-concurrently.md` (The runner that applies migrations).
* **Update**: Linked `architecture/pii-encryption-blind-index.md` to `bugs/blind-index-key-drift-forks-accounts.md` (What key drift does to blind indexes).
* **Update**: Linked `requirements/identity-pii-encrypted-at-rest.md` to `architecture/pii-encryption-blind-index.md` (The encryption and blind-index implementation).
* **Update**: Linked `decisions/content-encryption-boundary.md` to `requirements/ferpa-data-protection-open-items.md` (Open data-protection items).
* **Update**: Linked `decisions/content-encryption-boundary.md` to `requirements/identity-pii-encrypted-at-rest.md` (What is encrypted and what is not).
* **Update**: Linked `decisions/webr-self-hosted-client-side-r.md` to `facts/code-dev-ports-and-proxy.md` (COOP/COEP headers the dev servers send for WebR).
* **Update**: Linked `decisions/webr-self-hosted-client-side-r.md` to `bugs/webr-source-package-install-fails.md` (A WebR package-install bug).
* **Update**: Linked `decisions/canvas-instructor-token-roster-sync.md` to `decisions/course-membership-roles.md` (Roster sync creates course memberships).
* **Update**: Linked `decisions/in-process-extraction-and-ocr.md` to `requirements/single-writer-knowledge-and-extraction.md` (Extraction is single-writer too).
* **Update**: Linked `decisions/in-process-extraction-and-ocr.md` to `decisions/okf-bundle-knowledge-base.md` (Extraction feeds the bundle).
* **Update**: Linked `decisions/knowledge-persistence-s3-manifest.md` to `decisions/materials-object-storage-evolution.md` (Same object-storage interface).
* **Update**: Linked `decisions/knowledge-access-toggle-per-llm-config.md` to `decisions/okf-bundle-knowledge-base.md` (Switches the tutor's access to the bundle).
* **Update**: Linked `decisions/okf-bundle-knowledge-base.md` to `facts/code-okf-binary-pin.md` (The product's okf binary pin).
* **Update**: Linked `decisions/okf-bundle-knowledge-base.md` to `requirements/stakeholder-course-grounded-tutoring.md` (The stakeholder need it serves).
* **Update**: Linked `decisions/okf-bundle-knowledge-base.md` to `requirements/student-knowledge-access-read-only.md` (Student tools are read-only).
* **Update**: Linked `decisions/okf-bundle-knowledge-base.md` to `requirements/single-writer-knowledge-and-extraction.md` (One writer per bundle).
* **Update**: Linked `decisions/okf-bundle-knowledge-base.md` to `decisions/knowledge-persistence-s3-manifest.md` (How bundles persist).
* **Update**: Linked `decisions/okf-bundle-knowledge-base.md` to `facts/okf-knowledge-base-design-history.md` (From pgvector RAG to OKF bundles).
* **Update**: Linked `decisions/okf-bundle-knowledge-base.md` to `architecture/knowledge-base-okf.md` (The knowledge base as built).
* **Update**: Linked `decisions/llm-provider-gateway-and-failover.md` to `facts/code-runtime-env-vars.md` (Environment variables that configure providers).
* **Update**: Linked `decisions/llm-provider-gateway-and-failover.md` to `facts/code-pinned-ai-sdk-versions.md` (AI SDK versions are pinned exactly).
* **Update**: Linked `decisions/llm-provider-gateway-and-failover.md` to `facts/code-llmoxie-default-base-url-is-prod.md` (Unset base URL falls back to production).
* **Update**: Linked `decisions/llm-provider-gateway-and-failover.md` to `architecture/llm-tutor-pipeline.md` (Provider calls in the tutor pipeline).
* **Update**: Linked `decisions/prompt-template-most-specific-wins.md` to `architecture/eval-harness.md` (The eval exercises the real prompt builder).
* **Update**: Linked `decisions/prompt-template-most-specific-wins.md` to `architecture/llm-tutor-pipeline.md` (Prompt assembly in the tutor pipeline).
* **Update**: Linked `decisions/homework-status-derived-on-read.md` to `architecture/data-model-multi-tenancy.md` (Status is derived, not stored).
* **Update**: Linked `decisions/homework-status-derived-on-read.md` to `requirements/stakeholder-homework-modes-and-assistance-levels.md` (Homework modes stakeholders asked for).
* **Update**: Linked `decisions/submission-restart-voids.md` to `bugs/grader-fk-set-null-vs-check.md` (Grade constraints interacting with deletes).
* **Update**: Linked `decisions/submission-restart-voids.md` to `bugs/grade-stale-after-resubmission.md` (A grading bug from resubmission).
* **Update**: Linked `decisions/submission-restart-voids.md` to `facts/submission-attempt-model.md` (The attempt model this decision leads to).
* **Update**: Linked `decisions/messages-parts-jsonb.md` to `bugs/partial-stream-persisted-as-complete.md` (A persistence bug in streamed turns).
* **Update**: Linked `decisions/messages-parts-jsonb.md` to `facts/code-messages-not-null-backfill.md` (Adding NOT NULL columns to messages).
* **Update**: Linked `decisions/messages-parts-jsonb.md` to `architecture/llm-tutor-pipeline.md` (How chat messages are produced and stored).
* **Update**: Linked `decisions/course-membership-roles.md` to `requirements/stakeholder-instructor-visibility-of-student-data.md` (What instructors may see is still unresolved).
* **Update**: Linked `decisions/course-membership-roles.md` to `facts/authority-and-provisioning-gaps.md` (Known gaps in authority and provisioning).
* **Update**: Linked `decisions/course-membership-roles.md` to `architecture/auth-and-authorization.md` (Roles drive authorization checks).
* **Update**: Linked `decisions/shared-schema-tenancy-branded-scopes.md` to `bugs/org-delete-cascade-order.md` (Cascade ordering across tenant tables).
* **Update**: Linked `decisions/shared-schema-tenancy-branded-scopes.md` to `bugs/unordered-memberships-first-row.md` (A tenancy bug from an unordered membership query).
* **Update**: Linked `decisions/shared-schema-tenancy-branded-scopes.md` to `architecture/data-model-multi-tenancy.md` (The data model as built).
* **Update**: Linked `decisions/shared-schema-tenancy-branded-scopes.md` to `requirements/tenant-scoped-data-access.md` (The invariant the scopes enforce).
* **Update**: Linked `decisions/workos-authkit-sealed-session.md` to `facts/workos-deprovisioning-session-epoch.md` (How stateless sessions are revoked).
* **Update**: Linked `decisions/workos-authkit-sealed-session.md` to `architecture/auth-and-authorization.md` (Authentication as implemented).
* **Update**: Linked `decisions/floci-developer-local-aws-parity.md` to `facts/code-infra-tests.md` (Infra tests that stub the AWS toolchain).
* **Update**: Linked `decisions/floci-developer-local-aws-parity.md` to `architecture/infra-topology.md` (Floci runs the same Pulumi program locally).
* **Update**: Linked `decisions/tag-gated-aws-release-pipeline.md` to `facts/code-release-gate-posture-test.md` (A test that guards release posture of grader routes).
* **Update**: Linked `decisions/tag-gated-aws-release-pipeline.md` to `bugs/first-production-release-blockers.md` (Blockers hit by the first tagged release).
* **Update**: Linked `decisions/tag-gated-aws-release-pipeline.md` to `bugs/pulumi-bootstrap-errors-swallowed.md` (Release-log bug fixed on the way to the first deploy).
* **Update**: Linked `decisions/tag-gated-aws-release-pipeline.md` to `requirements/migrate-before-deploy.md` (Candidate migrations run before activation).
* **Update**: Linked `decisions/tag-gated-aws-release-pipeline.md` to `architecture/ci-release-pipeline.md` (The workflows as implemented).
* **Update**: Linked `decisions/github-environment-production-secrets.md` to `decisions/tag-gated-aws-release-pipeline.md` (Secrets reach Pulumi only inside the release workflow).
* **Update**: Linked `decisions/github-environment-production-secrets.md` to `requirements/production-secrets-handling.md` (The constraint this decision sets).
* **Update**: Linked `decisions/pulumi-s3-diy-backend.md` to `architecture/infra-topology.md` (State backend for the Pulumi program).
* **Update**: Linked `decisions/pulumi-s3-diy-backend.md` to `facts/aws-account-bootstrap-outside-pulumi.md` (The bootstrap script creates the state bucket and KMS key).
* **Update**: Linked `decisions/in-process-overdue-sweep.md` to `bugs/overdue-sweep-budget-and-races.md` (Bugs found in the sweep).
* **Update**: Linked `decisions/in-process-overdue-sweep.md` to `architecture/background-jobs-and-lifecycle.md` (How in-process jobs and shutdown are implemented).
* **Update**: Linked `decisions/single-task-full-app-service.md` to `decisions/in-process-overdue-sweep.md` (Background work runs inside the same task).
* **Update**: Linked `decisions/single-task-full-app-service.md` to `decisions/nat-free-public-subnet-task.md` (Networking of that single task).
* **Update**: Linked `decisions/aws-ecs-fargate-runtime.md` to `facts/code-stale-workers-era-docs.md` (Docs and comments still describing the Workers era).
* **Update**: Linked `decisions/aws-ecs-fargate-runtime.md` to `requirements/aws-region-us-west-2.md` (Region constraint for all AWS resources).
* **Update**: Linked `decisions/aws-ecs-fargate-runtime.md` to `decisions/single-task-full-app-service.md` (One task serves everything).
* **Update**: Linked `decisions/aws-ecs-fargate-runtime.md` to `architecture/infra-topology.md` (The AWS topology as built).
* **Update**: Linked `decisions/aws-ecs-fargate-runtime.md` to `facts/cloudflare-to-aws-replatform-lessons.md` (Why the interim Cloudflare/Neon stack was left).
* **Update**: Linked `decisions/monorepo-two-spas-one-hono-api.md` to `facts/code-gitignore-lib-anchoring.md` (A gitignore footgun that hit workspace source dirs).
* **Update**: Linked `decisions/monorepo-two-spas-one-hono-api.md` to `facts/code-typescript-and-install.md` (TypeScript versions and installs across workspaces).
* **Update**: Linked `decisions/monorepo-two-spas-one-hono-api.md` to `facts/code-turbo-evals-typecheck-race.md` (A turbo pipeline subtlety of the monorepo).
* **Update**: Linked `decisions/monorepo-two-spas-one-hono-api.md` to `facts/code-dev-ports-and-proxy.md` (Dev ports and proxies for the two SPAs and the API).
* **Update**: Linked `decisions/monorepo-two-spas-one-hono-api.md` to `architecture/admin-console.md` (The instructor SPA).
* **Update**: Linked `decisions/monorepo-two-spas-one-hono-api.md` to `architecture/request-path.md` (How requests flow through the one API and two SPAs).
* **Update**: Linked `decisions/typescript-rewrite-over-django-extension.md` to `decisions/monorepo-two-spas-one-hono-api.md` (Shape of the rewrite).
* **Update**: Linked `decisions/typescript-rewrite-over-django-extension.md` to `requirements/django-parity-baseline.md` (Parity with Django is the bar the rewrite must meet).
* **Update**: Linked `decisions/typescript-rewrite-over-django-extension.md` to `architecture/legacy-django.md` (The legacy app the rewrite replaces).
* **Update**: Linked `project/stakeholders-and-context.md` to `requirements/stakeholder-fall-quarter-pilot.md` (The pilot deadline stakeholders set).
* **Update**: Linked `project/implementation-plan.md` to `decisions/typescript-rewrite-over-django-extension.md` (The plan starts from the decision to rewrite in TypeScript).
* **Update**: Linked `project/current-state.md` to `bugs/first-production-release-blockers.md` (The first production release is the active frontier).
* **Update**: Linked `project/current-state.md` to `project/milestones.md` (Open work is tracked against these milestones).
* **Update**: Linked `project/milestones.md` to `project/implementation-plan.md` (The plan documents behind each milestone, as executed).
* **Update**: Linked `project/llteacher.md` to `project/milestones.md` (Milestone history of the port).
* **Update**: Linked `project/llteacher.md` to `project/stakeholders-and-context.md` (Who the project serves and the CDI shared-platform context).
* **Update**: Linked `project/llteacher.md` to `architecture/system-overview.md` (How the system described here is built).
* **Creation**: Documented concept `facts/skill-evals-authoring-lessons.md` (Lessons for writing skill-eval verifiers, samples and shims).
* **Creation**: Documented concept `architecture/skill-evals.md` (Agent-skill evaluation with Inspect and Harbor).
* **Creation**: Documented concept `decisions/project-template-adoption.md` (Adopt uw-ssec/project-template with pixi scoped to developer tooling).
* **Update**: Updated concept `facts/migration-index-collision-convention.md`.
* **Update**: Updated concept `requirements/migrate-before-deploy.md`.
* **Creation**: Documented concept `facts/code-release-gate-posture-test.md` (Grader-tier routes must declare a release-gate posture).
* **Creation**: Documented concept `facts/code-llmoxie-default-base-url-is-prod.md` (Unset LLMOXIE_BASE_URL sends traffic to production gateway).
* **Creation**: Documented concept `facts/code-infra-tests.md` (Infra tests: vitest + node:test in npm test; *.test.sh are manual).
* **Creation**: Documented concept `facts/code-typescript-and-install.md` (TypeScript 7 in apps, 5.9 in infra; stale node_modules breaks typecheck).
* **Creation**: Documented concept `facts/code-stale-workers-era-docs.md` (Workers/Neon-era comments and docs are stale).
* **Creation**: Documented concept `facts/code-okf-binary-pin.md` (okf binary must be v0.3.0; KNOWLEDGE_ROOT cannot be a symlink).
* **Creation**: Documented concept `facts/code-db-tests-skip-without-database-url.md` (DB-backed tests silently skip without DATABASE_URL).
* **Creation**: Documented concept `facts/code-pinned-ai-sdk-versions.md` (AI SDK packages are pinned to exact versions).
* **Creation**: Documented concept `facts/code-dev-ports-and-proxy.md` (Dev ports and API proxy targets).
* **Creation**: Documented concept `facts/code-runtime-env-vars.md` (Runtime environment variables for the Node API).
* **Creation**: Documented concept `facts/code-messages-not-null-backfill.md` (Adding NOT NULL columns to messages needs explicit backfill).
* **Creation**: Documented concept `facts/code-migrate-runner-split-and-concurrently.md` (scripts/migrate.ts: two-stage apply and CONCURRENTLY handling).
* **Creation**: Documented concept `facts/code-gitignore-lib-anchoring.md` (.gitignore lib/ must stay root-anchored).
* **Creation**: Documented concept `facts/code-turbo-evals-typecheck-race.md` (turbo typecheck race between evals and web).
* **Creation**: Documented concept `architecture/legacy-django.md` (Legacy Django app and its relation to the TS port).
* **Creation**: Documented concept `architecture/eval-harness.md` (Tutor-behavior eval harness (evals/)).
* **Creation**: Documented concept `architecture/ci-release-pipeline.md` (CI and release pipeline).
* **Creation**: Documented concept `architecture/infra-topology.md` (AWS infrastructure topology (Pulumi, ECS Fargate)).
* **Creation**: Documented concept `architecture/background-jobs-and-lifecycle.md` (In-process background work and shutdown lifecycle).
* **Creation**: Documented concept `architecture/admin-console.md` (Instructor admin console (apps/admin)).
* **Creation**: Documented concept `architecture/knowledge-base-okf.md` (Course knowledge base as built (OKF bundle, not vector RAG)).
* **Creation**: Documented concept `architecture/llm-tutor-pipeline.md` (LLM tutor chat pipeline).
* **Creation**: Documented concept `architecture/pii-encryption-blind-index.md` (PII encryption and blind indexes).
* **Creation**: Documented concept `architecture/auth-and-authorization.md` (Authentication and authorization).
* **Creation**: Documented concept `architecture/data-model-multi-tenancy.md` (Data model and shared-schema multi-tenancy).
* **Creation**: Documented concept `architecture/request-path.md` (Request path: Node adapter, Hono API, SPA fallbacks).
* **Creation**: Documented concept `architecture/system-overview.md` (LLTeacher v2 system overview).
* **Update**: Updated concept `requirements/migrate-before-deploy.md`.
* **Update**: Updated concept `requirements/production-secrets-handling.md`.
* **Update**: Updated concept `decisions/llm-provider-gateway-and-failover.md`.
* **Update**: Updated concept `decisions/canvas-instructor-token-roster-sync.md`.
* **Creation**: Documented concept `requirements/stakeholder-knowledge-gap-insight.md` (Stakeholder requirement: help instructors see where students have knowledge gaps).
* **Creation**: Documented concept `requirements/stakeholder-course-grounded-tutoring.md` (Stakeholder requirement: tutoring grounded in each course's own materials, per assignment).
* **Creation**: Documented concept `requirements/stakeholder-instructor-visibility-of-student-data.md` (Stakeholder requirement (unresolved): aggregate vs individual student data for instructors).
* **Creation**: Documented concept `requirements/stakeholder-homework-modes-and-assistance-levels.md` (Stakeholder requirement: tutor and homework modes, code as bonus, leveled prompts).
* **Creation**: Documented concept `requirements/stakeholder-fall-quarter-pilot.md` (Stakeholder requirement: usable for fall-quarter 2026 pilots).
* **Creation**: Documented concept `facts/workos-deprovisioning-session-epoch.md` (Revoking stateless WorkOS sessions with a per-user session epoch).
* **Creation**: Documented concept `facts/authority-and-provisioning-gaps.md` (Authorization model and known gaps: course-scoped roles, super admins, no course creation).
* **Creation**: Documented concept `facts/submission-attempt-model.md` (Submission attempt model: one mutable row now, attempt table deferred).
* **Creation**: Documented concept `facts/okf-knowledge-base-design-history.md` (Knowledge base: from pgvector RAG plan to filesystem-authoritative OKF bundle).
* **Creation**: Documented concept `facts/stale-root-claude-md.md` (Repo-root CLAUDE.md describes the Django legacy app, not the live stack).
* **Creation**: Documented concept `facts/aws-account-bootstrap-outside-pulumi.md` (Account-level AWS prerequisites live in an admin-run bootstrap script, not Pulumi).
* **Creation**: Documented concept `facts/cloudflare-to-aws-replatform-lessons.md` (Why the app left Cloudflare Workers and Neon: constraints that shaped the code).
* **Creation**: Documented concept `facts/migration-index-collision-convention.md` (Drizzle migration numbering: PR-open order wins, CI checks collisions).
* **Creation**: Documented concept `facts/eleven-dimension-review-process.md` (Review process: 11-dimension audits, findings filed as issues, live-DB verification).
* **Creation**: Documented concept `bugs/overdue-sweep-budget-and-races.md` (Overdue auto-submit sweep: per-org cap vs per-invocation budget, and abort-on-one-org).
* **Creation**: Documented concept `bugs/first-production-release-blockers.md` (First AWS production release blockers: new stack refresh and missing service-linked roles).
* **Creation**: Documented concept `bugs/pulumi-bootstrap-errors-swallowed.md` (Release logs hid Pulumi errors via /dev/null and command substitution).
* **Creation**: Documented concept `bugs/grade-stale-after-resubmission.md` (Resubmitting after grading leaves the grade describing replaced work).
* **Creation**: Documented concept `bugs/chat-rerender-per-token.md` (Chat surfaces rebuilt and re-scrolled on every streamed token).
* **Creation**: Documented concept `bugs/webr-source-package-install-fails.md` (WebR install.packages silently failed; tidyverse never loaded).
* **Creation**: Documented concept `bugs/unordered-memberships-first-row.md` (memberships[0] from an unordered query picked an arbitrary course).
* **Creation**: Documented concept `bugs/org-delete-cascade-order.md` (Org deletion bypasses RESTRICT FKs because of cascade ordering).
* **Creation**: Documented concept `bugs/grader-fk-set-null-vs-check.md` (ON DELETE SET NULL conflicted with a CHECK constraint on grades).
* **Creation**: Documented concept `bugs/invalid-concurrent-index-skipped.md` (Interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index that IF NOT EXISTS skips).
* **Creation**: Documented concept `bugs/client-history-system-message-injection.md` (Client-supplied chat history allowed system-message injection).
* **Creation**: Documented concept `bugs/partial-stream-persisted-as-complete.md` (Truncated or non-replayable assistant turns poison chat idempotency).
* **Creation**: Documented concept `bugs/blind-index-key-drift-forks-accounts.md` (BLIND_INDEX_KEY drift silently forks user accounts).
* **Creation**: Documented concept `project/stakeholders-and-context.md` (Stakeholders and CDI shared-platform context).
* **Creation**: Documented concept `project/current-state.md` (Project state as of 2026-10-06).
* **Creation**: Documented concept `project/milestones.md` (Milestones M1-M13 and what each delivered).
* **Creation**: Documented concept `project/llteacher.md` (LLTeacher v2 project overview).
* **Creation**: Documented concept `project/implementation-plan.md` (Implementation plan: the milestone sequence as it actually ran (M1 to M13)).
* **Creation**: Documented concept `requirements/ferpa-data-protection-open-items.md` (FERPA and HIPAA data-protection items are still open: audit, deletion, retention, and LLM payloads).
* **Creation**: Documented concept `requirements/aws-region-us-west-2.md` (All regional AWS resources live in us-west-2, and deploys refuse a stack whose region is stale).
* **Creation**: Documented concept `requirements/student-knowledge-access-read-only.md` (Students get read-only knowledge tools, scoped to their own course, and material is treated as untrusted).
* **Creation**: Documented concept `requirements/single-writer-knowledge-and-extraction.md` (Only one process may ever write a course's knowledge bundle or run material extraction).
* **Creation**: Documented concept `requirements/django-parity-baseline.md` (The TS port must reach Django feature parity first, and deviations must be written down).
* **Creation**: Documented concept `requirements/migrate-before-deploy.md` (Database migrations must finish before new application code serves traffic).
* **Creation**: Documented concept `requirements/production-secrets-handling.md` (Production secrets come only from GitHub environment secrets and Secrets Manager, never from code, logs, or arguments).
* **Creation**: Documented concept `requirements/identity-pii-encrypted-at-rest.md` (Identity PII is encrypted at rest with AES-256-GCM, and lookups go through HMAC blind indexes).
* **Creation**: Documented concept `requirements/tenant-scoped-data-access.md` (Data access is tenant-scoped: repositories take a branded scope, and routes check ownership).
* **Creation**: Documented concept `decisions/content-encryption-boundary.md` (Identity PII is encrypted at rest, while chat and grade content stay plaintext).
* **Creation**: Documented concept `decisions/webr-self-hosted-client-side-r.md` (R runs in the browser with self-hosted, exact-pinned WebR under COOP/COEP isolation).
* **Creation**: Documented concept `decisions/canvas-instructor-token-roster-sync.md` (Canvas integration uses an instructor-pasted API token and roster sync, with LTI 1.3 deferred).
* **Creation**: Documented concept `decisions/knowledge-access-toggle-per-llm-config.md` (Each LLM config can switch the tutor's knowledge access on or off; the instructor writes the search instruction).
* **Creation**: Documented concept `decisions/in-process-extraction-and-ocr.md` (Course-material extraction runs in-process with deterministic extractors, plus OCR for scanned PDFs).
* **Creation**: Documented concept `decisions/materials-object-storage-evolution.md` (Course-material storage moved from planned R2 to Neon Object Storage to AWS S3, behind one interface).
* **Creation**: Documented concept `decisions/knowledge-persistence-s3-manifest.md` (Knowledge bundles persist to S3 as content-addressed blobs plus a manifest, not on EFS).
* **Creation**: Documented concept `decisions/okf-bundle-knowledge-base.md` (Each course's knowledge base is an OKF bundle on the filesystem, served by the pinned okf binary).
* **Creation**: Documented concept `decisions/llm-provider-gateway-and-failover.md` (LLM calls go through the Vercel AI SDK to OpenAI-compatible providers, with LLMoxie as the platform default).
* **Creation**: Documented concept `decisions/prompt-template-most-specific-wins.md` (Prompt templates resolve most-specific-wins, from section up to a built-in default).
* **Creation**: Documented concept `decisions/homework-status-derived-on-read.md` (Homework status is derived on read from publishedAt and releasedAt).
* **Creation**: Documented concept `decisions/submission-restart-voids.md` (Restarting a submitted section voids its submission; one submission per student per section).
* **Creation**: Documented concept `decisions/messages-parts-jsonb.md` (Chat messages store AI SDK UIMessage parts as jsonb instead of a message_type enum).
* **Creation**: Documented concept `decisions/course-membership-roles.md` (Roles live on per-course memberships instead of global Teacher/Student profiles).
* **Creation**: Documented concept `decisions/shared-schema-tenancy-branded-scopes.md` (Shared-schema multi-tenancy with denormalized tenant columns and branded scope types).
* **Creation**: Documented concept `decisions/workos-authkit-sealed-session.md` (WorkOS AuthKit for identity, with a stateless AES-GCM sealed session cookie).
* **Creation**: Documented concept `decisions/floci-developer-local-aws-parity.md` (Floci emulates AWS for developers only, using the same Pulumi resource graph as production).
* **Creation**: Documented concept `decisions/tag-gated-aws-release-pipeline.md` (Releases deploy to AWS only from version tags, and migrations run before the new task is activated).
* **Creation**: Documented concept `decisions/github-environment-production-secrets.md` (The GitHub production environment is the source of truth for production secrets (ADR 0001)).
* **Creation**: Documented concept `decisions/pulumi-s3-diy-backend.md` (Production Pulumi state uses a self-managed S3 backend with KMS, not Pulumi Cloud).
* **Creation**: Documented concept `decisions/in-process-overdue-sweep.md` (The overdue-submission sweep runs inside the app with a PostgreSQL advisory lock, not as an EventBridge task).
* **Creation**: Documented concept `decisions/nat-free-public-subnet-task.md` (The Fargate task runs in public subnets with a public IP and no NAT gateway).
* **Creation**: Documented concept `decisions/single-task-full-app-service.md` (One ECS task serves the student app, instructor console, and API, with stop-before-start replacement).
* **Creation**: Documented concept `decisions/aws-ecs-fargate-runtime.md` (Node 24 on AWS ECS Fargate + RDS replaced the interim Cloudflare Workers + Neon runtime).
* **Creation**: Documented concept `decisions/monorepo-two-spas-one-hono-api.md` (Turborepo with a student SPA, an instructor SPA, and one shared Hono API).
* **Creation**: Documented concept `decisions/typescript-rewrite-over-django-extension.md` (Rewrite in TypeScript instead of extending the Django app).
* **Creation**: Initialized OKF v0.2 knowledge bundle.
