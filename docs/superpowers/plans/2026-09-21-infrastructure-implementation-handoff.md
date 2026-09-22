# Infrastructure implementation handoff — 2026-09-21

Branch: `ksdani/infra-production-simplification`.

## Implemented

The shared Pulumi program targets `us-west-2`: one ECS Fargate application,
ALB, private RDS PostgreSQL/pgvector, one private S3 bucket, two Secrets Manager
secrets, and their networking/IAM/logging dependencies. Optional domain mode
adds Route 53/ACM; domainless HTTP is only a bootstrap mode. There is no NAT
gateway, SQS queue, separate worker, scheduled ECS task, CloudFront, or EFS.

GitHub release automation builds/tests one image, transfers that tested artifact
to the protected production job, uses AWS OIDC, runs the exact candidate's
migrations before replacing the application, and records rollback references.
It never runs Floci. Application secrets are injected by the ECS execution role;
the task role supplies S3 credentials. GitHub still needs a Pulumi access-token
secret and non-secret deployment-role/stack variables. See [operations](../../../infra/README.md).

Knowledge Markdown and originals persist to the existing S3 bucket and restore
into a fresh task filesystem. Failed writes/failed rollback restores cannot
publish a partially recovered tree. The application remains a single writer.
The PR review update replaces whole-course ZIP persistence with changed-file
blobs and an atomic manifest. Legacy ZIPs are decoded off the event loop and
retained after migration. See [review disposition](2026-09-21-pr461-review-disposition.md)
and [operator recovery](../../knowledge-recovery.md).

## Original implementation verification (before PR review fixes)

- Five-workspace type checking passed.
- Full test run passed: 3,215 Vitest tests, 12 skipped; 18 native Node tests
  passed, with the optional image test separately exercised against the real image.
- All three application build tasks passed.
- Final independent whole-branch review and scoped fix re-review passed.
- Real Floci-created RDS/ECS, migrations, secret injection, S3 access, and
  knowledge create/edit/fresh-root restore/original/deletion were exercised.
- The final rebuilt image is `sha256:1e635ef67f2cc7c36884953c3f55fb7c39c1841ee7becf61d1522f52698d7386`
  (278,412,596 bytes). Its ID matches the running ECS container. Final migrations
  succeeded; `/`, `/admin`, and `/api/health` returned HTTP 200 at
  `http://localhost:8080`. The idle dedicated builder is stopped.
- The first concurrent final run timed out in an unchanged UI test. It passed
  alone in 1.9 seconds; the complete run with serialized workspaces then passed.
  No test was skipped or timeout increased to hide the failure.

No real AWS resources were applied. The branch was subsequently pushed as
[PR #461](https://github.com/uw-ssec/llteacher/pull/461). The feature-branch
[release validation run](https://github.com/uw-ssec/llteacher/actions/runs/35680592466)
passed its artifact job and skipped production deployment. This does not verify
AWS permissions or prove a real production release succeeds.

## Limits before public testing

Local WorkOS and LiteLLM credentials have been loaded from the owner's existing
development secrets; the local callback uses `http://localhost:8080`. Keep those
credentials out of Git and preserve the existing encryption keys and database.
Floci models the AWS resource APIs but does not prove real
IAM isolation or TLS behavior; its modeled HTTPS listener serves plaintext locally.

Before public AWS testing: complete reviewed OIDC/IAM/Pulumi bootstrap, supply
production secrets, select/delegate a domain and enable HTTPS, triage existing
dependency audit findings, and explicitly authorize deployment. Queue-based
processing, multi-task availability, full disaster recovery/data migration, and
the rest of Milestone 12 are not claimed complete.

## Implementation decisions and tradeoffs

| Decision | Reason | Cost or constraint |
| --- | --- | --- |
| Existing dedicated branch, parallel disjoint owners | Honor requested parallel implementation | Conflicting edits would need reconciliation |
| Preserve old service through candidate registration/migrations | Avoid premature interruption | Additional release-state configuration |
| Ephemeral test DB credentials in CI | Exercise real database tests | Separate isolated test configuration |
| HTTP bootstrap; HTTPS gate for public authenticated testing | No production domain selected | Domain setup is still required |
| Existing S3 for knowledge manifests and immutable blobs, not EFS | Keep durable data without another service | Metadata scans, retained history, and single-writer limit |
| Verified RDS TLS with regional CA bundle | Secure PostgreSQL connection | Maintain the CA bundle lifecycle |
| Refuse legacy local files without a remote snapshot | Prevent accidental deletion/upload | Explicit legacy migration step |
| One task, stop-before-start replacement | Avoid concurrent filesystem writers | Brief deployment downtime |

Old unused Docker images/cache cleanup reclaimed about 30.1 GB. Persistent
database volumes were retained. Future LLTeacher builds use a stable tag,
scoped image cleanup, and a dedicated builder with a roughly 2 GB cache target.
