# PR #461 review disposition

Source: [review at 26a5b7d](https://github.com/uw-ssec/llteacher/pull/461#issuecomment-5770560047).
The owner approved the following fixes without adding infrastructure. Validation
results belong in the implementation handoff and PR response, not in this plan.

## Required fixes

1. Replace per-mutation whole-course ZIP uploads with immutable content-addressed
   files and an atomic manifest published last. Cache unchanged file metadata;
   preserve durability-before-success and failed-mutation rollback. Decode legacy
   ZIPs off the event loop, retain their data, and migrate on the next write.
2. Distinguish malformed manifests/blobs/legacy ZIPs from transient storage
   failures. Emit safe operator diagnostics and provide explicit validated
   previous-version recovery. Never automatically erase or reseed course data.
3. Restrict task-role S3 access to course material and knowledge prefixes and
   test the one-task, stop-before-start deployment invariant. A shared task role
   is not per-tenant IAM isolation; application authorization remains necessary.
   Missing-object handling also uses a bounded exact-prefix list after GET/HEAD
   access denial: only a complete listing proving absence returns "missing".
   Existing objects and uncertain/denied listings fail closed. Selected recovery
   version failures remain fatal. This accounts for S3's documented
   [403-versus-404 behavior](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
   without broadening bucket listing or treating every 403 as absence.

## Additional corrections

- Handle migration tasks with no container exit code without bypassing useful
  diagnostics. Retry only confirmed terminal failures; never launch a second
  migrator after an uncertain timeout. Include task and log identifiers.
- Fail production activation without HTTPS, while allowing infrastructure-only
  bootstrap and local HTTP. Detect stale refreshed Pulumi region/config before
  deployment mutations and document safe remediation.
- Explain release-gate and local readiness failures without dumping secrets.
- Document production-only releases, qualified stack names, migration-runner
  arguments, and executable rollback steps.
- Bound the whole Node shutdown within 25 seconds, retain safe allowlisted
  scheduler failure categories, and name the advisory-lock constant.
- Preflight concurrent-index statements for replay safety before migrations run.
- Restore invalid-environment coverage and clean up small configuration/runbook
  issues identified in the review.

## Deliberate limits retained for this release

- **One writer, brief deployment downtime:** no autoscaling or HA. Do not change
  desired count or deployment percentages without redesigning persistence.
  Reads remain serialized per course; parallel reads and general multi-writer
  concurrency control are deferred.
- **Public-IP tasks, ALB-only ingress, private database:** no NAT, VPC endpoints,
  or Flow Logs were added. Unrestricted outbound access remains a security/cost
  tradeoff requiring explicit production deployment approval. HTTPS does not
  mitigate outbound exfiltration after compromise.
- **Production-only GitHub releases in us-west-2:** no automatic staging deploy
  or second AWS sandbox release pipeline. Multi-environment automation, separate
  sizing, reusable EventBridge jobs, and SQS remain outside this release.
- **Build SHA health response:** retained for deployment identity verification;
  it reveals a revision identifier, not credentials or private source.
- **Pinned OKF release with same-release checksum:** validates downloaded bytes
  but is not an independent upstream supply-chain trust root. Independent
  provenance/attestation remains future hardening.
- **No silent data recovery:** S3 versioning and an operator runbook support
  targeted repair, not automatic recovery from every failure or full disaster
  recovery. Old blobs/versions are retained; future garbage collection must
  respect every retained manifest before deleting anything.
- **Low-traffic optimizations deferred:** CI Docker layer caching, parallel
  restore writes, and reducing advisory-lock connection lifetime are not needed
  to clear the reported blockers. Functional image verification remains the
  stronger check alongside static Dockerfile guardrails.

Before real AWS deployment, configure protected GitHub production-environment
reviewers, OIDC and production secrets, delegate the domain and validate HTTPS,
and obtain the owner's explicit permission. Floci and branch workflow tests do
not prove real AWS IAM, certificate, DNS, or protected-environment behavior.
