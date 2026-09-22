# Task 7 — AWS release workflow report

## RED

- Added release-workflow and bootstrap script assertions, then observed both fail before their implementations existed.
- Added the health endpoint build-version assertion and observed it fail because the route returned only `status`.
- Updated the migration wrapper assertion for a public-IP candidate task definition; it failed against the former staging/private-network wrapper.

## GREEN

- Production-only, protected-environment release tags/manual-tag workflow runs isolated pgvector/OKF tests, typecheck, tests, build, then image publish.
- Bootstrap is production-only and runs only after an ECR absence check. It creates no service.
- Existing releases retain the service's prior task ARN through candidate registration and migration; first releases create no service until migration succeeds. The candidate task ARN is passed exactly to the migration task.
- The activated task is digest-pinned and carries `BUILD_SHA`; `/api/health` returns it and the smoke check rejects a mismatch.
- Migration execution uses public subnets, public IP, bounded retries/waiting, and structured ECS diagnostics without tailing application logs.
- Rollback references (previous task ARN/digest) are retained as workflow outputs. Secret rotations require a new forced ECS task deployment/revision.

## Results

- `bash infra/scripts/release-workflow.test.sh` — pass
- `bash infra/scripts/bootstrap-aws-infra.test.sh` — pass
- `bash infra/scripts/run-aws-migrations.test.sh` — pass
- `bash -n infra/scripts/bootstrap-aws-infra.sh infra/scripts/run-aws-migrations.sh` — pass
- `npm test --workspace=llteacher-web -- --run src/server/index.test.ts` — pass (23 tests)
- `npm run typecheck --workspace=llteacher-web` — blocked by pre-existing/concurrent `apps/web/src/node/server.test.ts` scheduler signature errors (four TypeScript errors), outside this task's files.
- No AWS account invocation or image push was performed locally.

## Commits

- Pending: `ci(release): build test and deploy to aws`

## Concerns

- This workflow relies on the coordinated infrastructure contract: `imageDigest`, `buildSha`, `serviceTaskDefinition`, `candidateTaskDefinitionArn`, `clusterName`, `serviceName`, `ecrRepositoryUrl`, and `appUrl`.
- ECS rolling settings permit brief downtime after migration; the workflow makes no zero-downtime claim.
