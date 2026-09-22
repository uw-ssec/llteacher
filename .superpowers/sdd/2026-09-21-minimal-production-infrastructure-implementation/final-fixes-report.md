# Final review fixwave report

Base: `c5c2c25`. Scope: final-review findings I1, I2, I3, and M1 only.

## Decisions and changes

- I1: `PersistentKnowledgeService` now keeps last-durable snapshot state in its
  existing map and tracks working-tree readiness in a separate `loaded` set.
  Mutation failures poison readiness before rollback. Only a complete restore
  marks the tree loaded again; if rollback fails, the next operation restores
  from the retained snapshot (including an explicitly loaded `null` snapshot)
  before it can run. Two focused tests inject partial non-empty restoration and
  empty-snapshot cleanup failures, then prove a later successful mutation and
  fresh-root restore neither lose acknowledged concepts nor publish the failed
  mutation. The tests double only the unavailable external `okf` process; the
  persistence, filesystem, zip, serialization, and object-store paths are real.
- I2: local migrations force both `AWS_REGION` and `AWS_DEFAULT_REGION` to
  `us-west-2`. The wrapper test starts with conflicting inherited values and
  observes west-2 in the AWS CLI process.
- I3: the committed local example defaults to `domainReady=false` and port
  8080. A pre-existing explicit `domainReady=true` remains supported: local-up
  derives `APP_URL` as Floci's plaintext `http://localhost:8443`, and verification
  probes the matching plaintext 8443 socket. The conditional Pulumi listener
  graph remains unchanged and the Floci TLS limitation is documented.
- M1: the cleanup fixture now includes an in-use labelled image and an unrelated
  image, validates the label-scoped query, and proves neither image is removed.
  Production cleanup code was already correct and did not change.

## RED/GREEN evidence

- RED: `bash infra/scripts/run-local-migrations.test.sh` exited 1 with inherited
  `AWS_REGION=eu-west-1` / `AWS_DEFAULT_REGION=us-east-1` before I2.
- RED: `bash infra/scripts/local-up.test.sh` exited 1 because a retained
  `domainReady=true` still configured the 8080 origin before I3.
- RED: `bash infra/scripts/verify-local-stack.test.sh` exited 1 because the
  true-mode verifier still probed 8080 before I3.
- The I1 regressions were authored before runtime implementation, but this host
  had no `okf` binary, so the existing integration describe was skipped rather
  than yielding a useful RED. A narrow executable test double made those tests
  deterministic; both then passed against the implementation. M1 is a coverage
  strengthening of already-correct behavior, so its first run was green.

Fresh focused verification:

- `npm test --workspace=llteacher-web -- --run src/server/knowledge/persistent-service.test.ts`
  — 2 passed, 15 real-OKF cases skipped because the binary is absent.
- `npm run typecheck --workspace=llteacher-web` — pass.
- `npm run typecheck --workspace=infra` — pass.
- `bash infra/scripts/run-local-migrations.test.sh` — pass.
- `bash infra/scripts/run-local-migrations-retry.test.sh` — pass.
- `bash infra/scripts/local-up.test.sh` — pass.
- `bash infra/scripts/verify-local-stack.test.sh` — pass.
- `bash infra/scripts/local-image-cleanup.test.sh` — pass.
- `bash -n infra/scripts/*.sh` — pass.
- `git diff --check` — pass.

No real AWS calls, external Git pushes, Docker builds, or Docker runtime
operations were performed. The controller owns full-suite, image rebuild, and
local deployment verification.
