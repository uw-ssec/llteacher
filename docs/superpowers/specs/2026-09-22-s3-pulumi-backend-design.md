# S3-backed Pulumi production deployment design

Date: 2026-09-22

Status: approved design for implementation planning

## Goal

Move LLTeacher's production Pulumi state from the planned Pulumi Cloud backend
to a self-managed Amazon S3 backend in AWS account `055237683908`, while
preserving the existing protected, tag-gated GitHub Actions release process.
The design must keep permanent AWS credentials out of GitHub, encrypt Pulumi
state and configuration secrets with AWS KMS, constrain deployment access to
the LLTeacher production environment, and retain explicit approval gates before
AWS infrastructure creation and application release.

## Current state

- Repository: `uw-ssec/llteacher`.
- Working branch and open PR: `ksdani/infra-production-simplification`, PR #461
  against `staging`.
- AWS account: `055237683908`.
- Regional resources: `us-west-2`; IAM and Route 53 remain global services.
- An empty Pulumi Cloud stack exists at
  `ksdani-uw-edu/llteacher-infra/production`. It contains no AWS resources or
  production secrets and will not be used for deployment.
- The current release workflow expects a Pulumi Cloud access token and a
  Cloud-qualified stack name. Those assumptions must change before deployment.
- Production application activation requires a valid domain and HTTPS with
  `domainReady=true`. Domainless mode is limited to base-infrastructure
  bootstrap with `deployApp=false`.

## Decisions

### Backend and stack identity

- Use an S3 DIY backend rather than Pulumi Cloud.
- State bucket:
  `llteacher-pulumi-state-055237683908-us-west-2`.
- Backend URL:
  `s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra`.
- Project remains `llteacher-infra` and the stack name is exactly `production`.
- Initialize a fresh S3-backed stack. Do not migrate the empty Cloud stack.
- Retain the empty Cloud stack until the S3 stack initializes and previews
  successfully. Deleting it requires separate approval.

### Bootstrap ownership

The following resources exist outside the main LLTeacher Pulumi stack so that
the stack never owns or deletes its own state and deployment identity:

- S3 state bucket.
- Customer-managed KMS key and alias `alias/llteacher-pulumi-state`.
- GitHub Actions OIDC provider, if the account does not already have it.
- GitHub deployment role `llteacher-production-deploy` and its policies.

Bootstrap uses reviewed, one-time AWS CLI commands documented in PR #461. It
does not introduce a bootstrap script, bootstrap Pulumi project, or CloudFormation
stack. Exact JSON trust, key, and bucket policies are checked into the repository.
The deployment permission policy is a checked-in template because the KMS key
ARN is not known until key creation; the documented procedure renders that one
explicit substitution, displays the final JSON for review, and then applies it.

### State protection and encryption

The state bucket has:

- S3 Versioning enabled.
- Bucket-owner-enforced object ownership with ACLs disabled.
- All four S3 Block Public Access controls enabled.
- Default server-side encryption using the dedicated customer-managed KMS key.
- A bucket policy denying requests that do not use TLS.
- No lifecycle rule that automatically deletes current or noncurrent state
  versions in the initial release.
- Identifying LLTeacher production and bootstrap-management tags.

The same KMS key protects Pulumi configuration secrets through the `awskms`
secrets provider. Automatic key rotation is enabled. The key policy enables
account IAM policies and the deployment role receives only the cryptographic
operations required for S3 and Pulumi secrets. The role receives no key-policy
administration or key-deletion permission.

The bucket relies on default SSE-KMS. It does not require every writer to send
an explicit encryption header because that could reject compatible Pulumi S3
operations even though bucket encryption would otherwise protect the object.

## GitHub Actions authentication and authorization

GitHub Actions continues to use short-lived AWS credentials from OIDC. It never
stores permanent AWS access keys.

The account-wide provider is:

- Issuer: `https://token.actions.githubusercontent.com`.
- Audience: `sts.amazonaws.com`.

The deployment role trust is limited to:

- Audience: `sts.amazonaws.com`.
- Subject: `repo:uw-ssec/llteacher:environment:production`.

The GitHub `production` environment must have required reviewers and deployment
tag restrictions. The release workflow remains limited to version tags, and its
existing `production-release` concurrency group continues to serialize updates.

The deployment role receives:

- `s3:ListBucket` only as needed for the Pulumi backend prefix.
- Object read, write, and delete operations only under that prefix, including
  Pulumi checkpoints, history, and locks.
- KMS encrypt, decrypt, re-encrypt, data-key generation, and key-description
  operations only for the dedicated state key.
- Reviewed creation, read, update, and deletion actions required for the
  LLTeacher VPC, ECS/ECR, RDS, application S3 bucket, Secrets Manager,
  CloudWatch Logs, Route 53, ACM, and prefixed IAM resources.
- `iam:PassRole` only for `llteacher-production-*` ECS task and execution roles
  and only when passed to `ecs-tasks.amazonaws.com`.

The role does not receive `AdministratorAccess`, unrelated bucket access,
wildcard KMS cryptographic access, or authority to administer or delete the
state key. AWS actions that cannot be resource-scoped may use `Resource: "*"`
only with the available region, service, account, name, and tag conditions.

The main Pulumi stack continues to own application runtime roles. It does not
own the GitHub deployment role. Application task roles never receive access to
the Pulumi state bucket or state key.

## Release workflow changes

The production job removes `PULUMI_ACCESS_TOKEN` and adds these non-secret
GitHub production environment variables:

- `AWS_DEPLOY_ROLE_ARN` containing the deployment role ARN.
- `PULUMI_BACKEND_URL` containing the exact S3 backend URL.
- `PULUMI_STACK` with the exact value `production`.

After installing Pulumi and before reading stack configuration, the job:

1. Assumes the deployment role with `aws-actions/configure-aws-credentials`.
2. Validates the account, role, region, backend URL, and stack name.
3. Runs `pulumi login "$PULUMI_BACKEND_URL"`.
4. Runs `pulumi -C infra stack select "$PULUMI_STACK" --non-interactive`.
5. Refreshes encrypted stack configuration.
6. Continues the existing tested-image, exact-candidate migration, activation,
   stability, health/version, and rollback-reference flow.

Release validation accepts only stack `production`, backend URL
`s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra`, and region
`us-west-2`. Existing tag, protected-environment, HTTPS, commit, image-digest,
migration, and service-stability checks remain mandatory.

Pulumi's S3 backend lock objects supplement GitHub's release concurrency. Both
protections remain enabled: GitHub prevents overlapping intended releases, and
Pulumi prevents concurrent state updates from other operators.

## Implementation scope in PR #461

The implementation updates:

- `.github/workflows/release.yml`.
- Release helper validation and usage messages.
- Release workflow and shell contract tests.
- `infra/README.md`.
- Reviewable bootstrap IAM trust and permission JSON documents.
- Documentation that still describes Pulumi Cloud as the production backend.

Historical design and implementation documents must either be updated where
they remain normative or clearly point to this design as the superseding
backend decision. The change must remove operational instructions that require
`PULUMI_ACCESS_TOKEN` or an organization-qualified production stack.

## Execution phases and approval gates

### Phase 1: update and verify PR #461

Implement the backend, workflow, policy, documentation, and test changes. Push
them to the existing PR branch and require all local contract tests and hosted
CI to pass again. This phase performs no AWS mutation.

### Phase 2: bootstrap state and CI identity

After reviewing the exact commands and policies, reconfirm the caller is account
`055237683908`, profile `default`, and region `us-west-2`. Then create and verify
the KMS key, state bucket, OIDC provider if absent, and deployment role. Configure
the GitHub protected production environment and its non-secret variables.

Every mutating command is preceded by a read-only existence check and followed
by a read-only verification. If a command partially succeeds, stop and
reconcile the resulting resource instead of deleting it and retrying blindly.

### Phase 3: initialize and preview

Log into the S3 backend and initialize stack `production` with the KMS secrets
provider. Set normal production configuration and encrypted secrets without
printing secret values, placing them in shell history, or copying local Floci
credentials without explicit approval.

Initial configuration keeps:

- `aws:region=us-west-2`.
- `environment=production`.
- `provisionService=false`.
- `deployApp=false`.

Production cryptographic and database secrets are newly generated. Production
WorkOS and LLM provider values must be supplied explicitly from approved
production sources. Run `pulumi preview` only, then review resource counts,
network exposure, IAM, backup and deletion protection, and recurring costs.

### Phase 4: base infrastructure

Run the first `pulumi up` only after separate explicit approval. The base update
creates networking, ALB, RDS, application storage, secrets, ECR, DNS/ACM when a
domain is configured, and supporting roles. `provisionService=false` and
`deployApp=false` keep the application service inactive, but ALB, RDS, KMS, and
storage still incur charges.

### Phase 5: HTTPS readiness

Delegate the Route 53 hosted zone at the registrar, verify DNS and ACM
validation, set `domainReady=true`, preview, and apply HTTPS activation. Register
the exact WorkOS callback `https://<domain>/api/auth/callback`. A production
application release is forbidden before this phase succeeds.

### Phase 6: application release

After PR merge and separate release approval, create an approved version tag.
GitHub Actions builds and tests one immutable image, publishes that artifact,
runs migrations from the exact candidate task definition, activates it, waits
for ECS stability, and verifies the deployed commit. Rollback references are
recorded, but database migrations are not automatically reversed.

## Failure and recovery behavior

- If the proposed state bucket name is already owned by another account, stop
  and select a new reviewed name.
- Reuse an existing account-wide GitHub OIDC provider rather than creating a
  duplicate.
- Never delete the state bucket, KMS key, versions, or locks as a
  troubleshooting shortcut.
- Do not enable automatic expiration of state versions during initial rollout.
- If state recovery is required, identify an explicit S3 version, preserve the
  current object, and follow a reviewed recovery procedure before promotion.
- If KMS access fails, repair the policy or role; never replace the key while it
  protects active state.
- If a preview targets an unexpected backend, account, region, or stack, stop
  before applying.
- If real bootstrap outputs differ from the reviewed workflow assumptions,
  update and re-review PR #461 before deployment.
- Keep local Floci containers, volumes, encrypted state, keys, and seed data
  untouched throughout production bootstrap.

## Verification requirements

Automated contracts must prove that:

- The workflow contains no Pulumi Cloud access token.
- AWS OIDC authentication happens before S3 backend access.
- Pulumi login and stack selection happen before refresh, preview, or update.
- The stack is exactly `production` and the backend URL is exact.
- Release helpers reject other stacks, backends, regions, malformed task
  definitions, and non-HTTPS production activation.
- Existing artifact integrity, migration retry/stop, ECS stability, health
  version, and rollback-summary contracts continue to pass.
- Local Floci commands remain isolated to stack `local` and are unaffected.

Manual verification must confirm:

- Caller account and region.
- KMS rotation, key policy, and scoped role access.
- Bucket ownership, encryption, versioning, public-access block, TLS policy,
  and lack of automatic state-version deletion.
- OIDC provider audience and exact role subject.
- GitHub production environment reviewers, tag restrictions, and variables.
- S3 stack initialization, KMS secrets provider, lock behavior, refresh, and a
  no-apply preview.
- Final domain delegation, ACM issuance, HTTPS health endpoint, and WorkOS
  callback before release.

## Non-goals

- No application release from a branch push.
- No Pulumi Cloud organization, subscription, access token, or state transfer.
- No automatic state-bucket or KMS-key deletion.
- No automatic domain purchase or registrar mutation.
- No copying of development credentials into production by default.
- No change to local Floci state or data.
- No SQS worker, multi-task scaling, full disaster recovery program, or other
  deferred Milestone 12 scope.
