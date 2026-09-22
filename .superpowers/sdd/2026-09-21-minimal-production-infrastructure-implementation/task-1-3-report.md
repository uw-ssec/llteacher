# Tasks 1–3 implementation report

Status: DONE_WITH_CONCERNS (local integration and real AWS validation owned by coordinator).

## Changes

- Enforced us-west-2 for all stacks/providers/images/AZs; rejected remote endpoints in local config; added Route 53 emulator endpoint.
- Removed NAT/EIP/private app routes and scheduled ECS infrastructure. Public Fargate tasks accept only ALB ingress; private RDS accepts only application ingress.
- Added owned hosted zone, ACM certificate/DNS records and ALB alias. Domainless bootstrap uses HTTP. Domain configured with domainReady=false creates delegation inputs without blocking on CertificateValidation; domainReady=true validates/enables HTTPS. Same conditional graph locally/AWS.
- Added exact two-secret execution policy and separate S3 bucket/object action scopes, including DeleteObject. Runtime secret exists in every environment. Injected region/bucket/build SHA and local-only endpoint/credentials.
- Protected/encrypted/versioned materials storage, thirty-day noncurrent-version expiration. Kept private RDS protection/backups, added verify-full PostgreSQL TLS outside local (image owner supplies RDS CA trust).
- Added candidate imageDigest/buildSha and serviceTaskDefinition config. The serving service can remain pinned while a new candidate is migrated. Task revisions use skipDestroy so old revisions remain available for rollback. Root requested desired-count-one stop-before-start deployment (0/100 percentages) to avoid concurrent filesystem knowledge writers.
- Added local-only appOrigin for emulator socket access. Outputs include candidateTaskDefinitionArn, serviceTaskDefinition, clusterName/serviceName, imageDigest, logGroupName, ecrRepositoryUrl, appSubnetIds/appSecurityGroupId, appUrl, hostedZoneNameServers. imageDigest means candidate digest, not necessarily the pinned active service image.
- Migrated S3 adapter from static aws4fetch to AWS SDK S3 credential chain. AWS needs only bucket and region; endpoint/static credentials are local. Added AWS_REGION runtime binding.

## RED / GREEN evidence

- Config tests initially failed on required domain/hosted zone, absent region and digest support. Graph tests failed on private task placement, unequal graphs, missing secret policy and storage protections.
- SDK tests initially failed because bucket-only runtime rejected configuration and static signing required an access key. A real loopback HTTP metadata/S3 server now proves the SDK retrieves temporary ECS credentials and signs with the session token and us-west-2 scope.
- Later regression tests failed before adding local appOrigin, retaining task revisions, and verify-full TLS.
- Final `npm test --workspace=infra`: 19 passed.
- Final focused runtime/storage tests: 29 passed across config.test.ts, objectStore.test.ts, objectStore.aws.test.ts.
- Infra typecheck/build and web typecheck passed. git diff --check passed.
- Coordinator owns whole-repository suite and real Floci integration to avoid duplicate runs.

## Concerns / handoff

- No AWS apply or push performed. Floci DNS/TLS and SDK transfer integration remain coordinator/local owner checks.
- Pulumi emits deprecation warnings for BucketVersioningV2 and BucketLifecycleConfigurationV2 aliases. They function and typecheck; replacement can be mechanical later.
- HTTP bootstrap must not be presented as authenticated production readiness. Domain delegation and valid TLS remain a launch gate.
- Rollback workflow must derive prior image digest from the actual pinned task, not the candidate imageDigest output. Coordinator notified.
- Retained task definitions are small control-plane records; future housekeeping must preserve active/rollback revisions.
- Root owns README/credential/rotation/lifecycle docs, migration shell regional fallback, dependency installation, RDS CA image trust, and durable knowledge work.

Commit: `fix(infra): implement minimal regional application stack and task-role storage` (hash returned in implementation handoff).
