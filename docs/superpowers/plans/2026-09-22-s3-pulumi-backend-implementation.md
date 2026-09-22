# S3-backed Pulumi Production Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update PR #461 so LLTeacher production uses a protected S3 DIY Pulumi backend and AWS KMS secrets provider through GitHub OIDC, with reviewed one-time AWS CLI bootstrap instructions and no Pulumi Cloud dependency.

**Architecture:** Keep the existing tag-gated release pipeline and application infrastructure program, but authenticate to AWS before explicitly logging Pulumi into the production S3 backend. Bootstrap-owned S3, KMS, OIDC, and deployment-role resources are described by reviewable JSON policies and one-time CLI instructions; the main Pulumi stack never owns them.

**Tech Stack:** GitHub Actions YAML, Bash, Node.js native tests, AWS IAM/S3/KMS/OIDC, Pulumi CLI 3.x with AWS provider, jq.

**Spec:** `docs/superpowers/specs/2026-09-22-s3-pulumi-backend-design.md`

## Global Constraints

- AWS account is exactly `055237683908`; regional resources are exactly `us-west-2`.
- Production backend URL is exactly `s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra`.
- Pulumi project remains `llteacher-infra`; DIY stack name is exactly `production`.
- GitHub OIDC subject is exactly `repo:uw-ssec/llteacher:environment:production`; audience is exactly `sts.amazonaws.com`.
- Production application activation still requires a valid `domainName` and `domainReady=true`.
- Remove `PULUMI_ACCESS_TOKEN`; never add permanent AWS credentials or application secrets to GitHub.
- Do not create, update, or delete AWS resources while implementing this plan.
- Do not merge PR #461, create a release tag, or dispatch a production workflow while implementing this plan.
- Preserve local Floci containers, volumes, Pulumi state, encryption keys, and seeded data.

## Review Focus

- A missing or altered backend URL must fail before any Pulumi or AWS mutation; Task 1 adds direct helper tests and Task 2 adds workflow ordering tests.
- A wrong account, region, stack, or GitHub deployment role must fail before backend selection; Task 1 pins all four validations.
- An existing account-wide GitHub OIDC provider must be reused, while an absent provider is created once; Task 4 documents and tests the decision branch.
- A partially created key or bucket must be inspected and reconciled rather than deleted or recreated; Task 4 provides explicit verification and stop conditions.
- The rendered deployment policy must replace only the KMS ARN token and must not gain administrator, unrelated S3, wildcard cryptographic, or key-deletion access; Task 3 validates the template structurally.

---

### Task 1: Enforce the S3 production target in release helpers

**Files:**
- Modify: `infra/scripts/aws-release-common.sh`
- Modify: `infra/scripts/aws-release.test.mjs`
- Modify: `infra/scripts/bootstrap-aws-infra.sh`
- Modify: `infra/scripts/prepare-aws-release.sh`
- Modify: `infra/scripts/run-aws-migrations.sh`

**Interfaces:**
- Consumes: environment variables `AWS_REGION`, `PULUMI_BACKEND_URL`; positional stack argument.
- Produces: `validate_release_target(stack)` accepting only `production` plus the exact backend and region; `validate_aws_account(account)` accepting only `055237683908`.

- [ ] **Step 1: Change the fixture to the new valid production target and add failing validation cases**

In `infra/scripts/aws-release.test.mjs`, change the valid stack fixture and add the exact backend to the environment:

```js
const stack = 'production';
const backend = 's3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra';
// fixture env additions
PULUMI_BACKEND_URL: backend,
```

Replace the old invalid-stack loop with cases for `''`, `local`,
`example/llteacher-infra/production`, and `staging`. Add separate cases proving
that an empty or altered `PULUMI_BACKEND_URL` and empty/wrong region produce no
stubbed API calls. Add this direct account test:

```js
test('release validation rejects a different AWS account', () => {
  const command = `. "${join(scripts, 'aws-release-common.sh')}"; validate_aws_account "$1"`;
  for (const account of ['', '000000000000', '055237683909']) {
    const result = spawnSync('bash', ['-c', command, 'validate', account], {
      env: { ...process.env, AWS_REGION: 'us-west-2', PULUMI_BACKEND_URL: backend },
      encoding: 'utf8',
    });
    failure(result);
    assert.match(result.stderr, /AWS account must be 055237683908/);
  }
});
```

- [ ] **Step 2: Run the helper tests and verify the new target cases fail**

Run:

```bash
node --test infra/scripts/aws-release.test.mjs
```

Expected: failures because `validate_release_target` still requires a Cloud-qualified stack and `validate_aws_account` does not exist.

- [ ] **Step 3: Implement exact stack, backend, region, and account validation**

In `infra/scripts/aws-release-common.sh`, use constants and validation with this contract:

```bash
readonly LLTEACHER_PRODUCTION_STACK=production
readonly LLTEACHER_PRODUCTION_BACKEND='s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra'
readonly LLTEACHER_PRODUCTION_ACCOUNT=055237683908

validate_release_target() {
  [[ "${1:-}" == "$LLTEACHER_PRODUCTION_STACK" ]] || die 'PULUMI_STACK must be production.'
  [[ "${PULUMI_BACKEND_URL:-}" == "$LLTEACHER_PRODUCTION_BACKEND" ]] || die "PULUMI_BACKEND_URL must be $LLTEACHER_PRODUCTION_BACKEND."
  [[ "${AWS_REGION:-}" == us-west-2 ]] || die 'AWS_REGION must be us-west-2.'
  export AWS_DEFAULT_REGION="$AWS_REGION"
}

validate_aws_account() {
  [[ "${1:-}" == "$LLTEACHER_PRODUCTION_ACCOUNT" ]] || die "AWS account must be $LLTEACHER_PRODUCTION_ACCOUNT."
}
```

Update the three production helper usage messages to show `production` rather
than `organization/llteacher-infra/production`. Do not alter local scripts,
which continue to require stack `local` and their local backend.

- [ ] **Step 4: Run focused helper contracts**

Run:

```bash
node --test infra/scripts/aws-release.test.mjs
bash infra/scripts/bootstrap-aws-infra.test.sh
bash infra/scripts/run-aws-migrations.test.sh
```

Expected: all tests pass, including wrong-stack, wrong-backend, wrong-account,
wrong-region, migration retry, and pre-mutation rejection cases.

- [ ] **Step 5: Commit the release-target contract**

```bash
git add infra/scripts/aws-release-common.sh infra/scripts/aws-release.test.mjs infra/scripts/bootstrap-aws-infra.sh infra/scripts/prepare-aws-release.sh infra/scripts/run-aws-migrations.sh
git commit -m "fix: validate S3 Pulumi production target"
```

### Task 2: Authenticate and select the S3 backend in GitHub Actions

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `infra/scripts/release-workflow.test.mjs`

**Interfaces:**
- Consumes: GitHub production variables `AWS_DEPLOY_ROLE_ARN`, `PULUMI_BACKEND_URL`, and `PULUMI_STACK`.
- Produces: an authenticated production runner with the exact S3 backend and stack selected before configuration refresh or deployment.

- [ ] **Step 1: Add failing workflow structure and ordering tests**

Add tests to `infra/scripts/release-workflow.test.mjs` that assert:

```js
test('production uses the reviewed S3 backend without a Pulumi Cloud token', () => {
  const env = workflow.jobs.production.env;
  assert.equal(env.STACK, '${{ vars.PULUMI_STACK }}');
  assert.equal(env.PULUMI_BACKEND_URL, '${{ vars.PULUMI_BACKEND_URL }}');
  assert.equal(env.PULUMI_ACCESS_TOKEN, undefined);
  assert(!readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8').includes('PULUMI_ACCESS_TOKEN'));
});

test('AWS identity and S3 backend are selected before stack reads or mutations', () => {
  const steps = workflow.jobs.production.steps;
  const oidc = steps.findIndex(s => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
  const select = steps.findIndex(s => s.name === 'Validate AWS identity and select Pulumi backend');
  const refresh = steps.findIndex(s => s.name === 'Refresh encrypted stack configuration');
  const mutate = steps.findIndex(s => s.name === 'Bootstrap base infrastructure only when ECR is absent');
  assert(oidc >= 0 && select > oidc && refresh > select && mutate > refresh);
  assert.match(steps[select].run, /aws sts get-caller-identity/);
  assert.match(steps[select].run, /validate_aws_account/);
  assert.match(steps[select].run, /pulumi login "\$PULUMI_BACKEND_URL"/);
  assert.match(steps[select].run, /stack select "\$STACK" --non-interactive/);
});
```

Retain existing tests for protected tag-only OIDC, tested artifact identity,
configuration validation, migrations, stability, and rollback output.

- [ ] **Step 2: Run the workflow contract and verify it fails**

```bash
node --test infra/scripts/release-workflow.test.mjs
```

Expected: failures because the workflow still exports `PULUMI_ACCESS_TOKEN` and
has no explicit S3 login/selection step.

- [ ] **Step 3: Update the production workflow environment and ordering**

In `.github/workflows/release.yml`, make the production environment:

```yaml
env:
  AWS_REGION: us-west-2
  STACK: ${{ vars.PULUMI_STACK }}
  PULUMI_BACKEND_URL: ${{ vars.PULUMI_BACKEND_URL }}
```

Remove `PULUMI_ACCESS_TOKEN`. Keep installation/build and the Pulumi version
check, then configure AWS credentials. Immediately after OIDC, add:

```yaml
- name: Validate AWS identity and select Pulumi backend
  run: |
    source infra/scripts/aws-release-common.sh
    validate_release_target "$STACK"
    account=$(aws sts get-caller-identity --query Account --output text)
    validate_aws_account "$account"
    pulumi login "$PULUMI_BACKEND_URL"
    pulumi -C infra stack select "$STACK" --non-interactive
```

Keep configuration refresh and HTTPS validation after this step. Do not change
the version-tag gate, environment, concurrency, tested-image handoff, candidate
migration, activation, health/version check, or rollback summary.

- [ ] **Step 4: Run workflow and helper contracts**

```bash
node --test infra/scripts/release-workflow.test.mjs
node --test infra/scripts/aws-release.test.mjs
bash infra/scripts/release-workflow.test.sh
```

Expected: all pass; every embedded workflow shell block parses under Bash.

- [ ] **Step 5: Commit the workflow change**

```bash
git add .github/workflows/release.yml infra/scripts/release-workflow.test.mjs
git commit -m "ci: use S3 Pulumi production backend"
```

### Task 3: Add reviewable bootstrap security policies

**Files:**
- Create: `infra/bootstrap/pulumi-state-kms-key-policy.json`
- Create: `infra/bootstrap/pulumi-state-bucket-policy.json`
- Create: `infra/bootstrap/github-oidc-trust-policy.json`
- Create: `infra/bootstrap/github-deploy-policy.template.json`
- Create: `infra/bootstrap/github-compute-policy.json`
- Create: `infra/bootstrap/github-data-policy.json`
- Create: `infra/bootstrap/github-network-policy.json`
- Create: `infra/bootstrap/runtime-permissions-boundary.json`
- Create: `infra/scripts/bootstrap-policy.test.mjs`
- Modify: `infra/src/app.ts`, `infra/src/network.ts`, `infra/src/dns.ts`, `infra/src/resources.test.ts`

**Interfaces:**
- Consumes: fixed account, region, bucket, prefix, repository, environment, and role names; runtime substitution `${KMS_KEY_ARN}`.
- Produces: syntactically valid, least-privilege policy inputs for the documented AWS CLI bootstrap.

- [ ] **Step 1: Write structural tests for all eight policy documents**

Create `infra/scripts/bootstrap-policy.test.mjs`. Parse each JSON file and assert:

```js
const account = '055237683908';
const region = 'us-west-2';
const bucket = 'llteacher-pulumi-state-055237683908-us-west-2';
const prefix = 'llteacher-infra/.pulumi/';
const oidcProvider = `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`;
const deployRole = `arn:aws:iam::${account}:role/llteacher-production-deploy`;
```

Tests must prove:

- The KMS policy enables account IAM policies through principal
  `arn:aws:iam::055237683908:root` and contains no external principal.
- The bucket policy has only a deny for `aws:SecureTransport=false` covering
  the bucket and its objects.
- The trust policy has only `sts:AssumeRoleWithWebIdentity`, the exact OIDC
  provider, exact audience, and exact environment subject.
- The deployment template contains `${KMS_KEY_ARN}` exactly once.
- State list access is constrained to `llteacher-infra/.pulumi` and its
  descendants; state object operations use only
  `arn:aws:s3:::llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra/.pulumi/*`.
- KMS cryptographic actions use only `${KMS_KEY_ARN}` and exclude
  `kms:PutKeyPolicy`, `kms:DisableKey`, and `kms:ScheduleKeyDeletion`.
- No statement grants `Action: "*"`, `iam:*`, `s3:*` with Allow, or
  `AdministratorAccess`.
- IAM role lifecycle and `iam:PassRole` resources match only
  `arn:aws:iam::055237683908:role/llteacher-production-execution-role-*` and
  `arn:aws:iam::055237683908:role/llteacher-production-task-role-*`, and pass-role is
  conditioned on `iam:PassedToService=ecs-tasks.amazonaws.com`.
- Creation requires the exact bootstrap-owned runtime permissions boundary;
  deployment grants cannot alter/remove boundaries or modify the deploy role.
- Each of four deployment managed policies and the separate runtime boundary
  fits below 6,144 compact JSON characters after rendering. The boundary excludes
  state, KMS and IAM administration and permits only the runtime capability union.
- EC2 mutations reject unrelated/untagged resources. New network resources require
  `LLTeacherStack=production` request tags; ownership cannot be claimed by standalone
  tagging, changed, or removed. Production resource mocks prove tags are supplied
  at creation and both runtime roles receive the boundary; local Floci is unaffected.
- Production ACM is operator-owned. Tests prove exact account/region/UUID
  certificateArn configuration, matching domain/tag/ISSUED validation, read-only
  certificate lookup, no production certificate/validation resource creation,
  and no ACM listing or write permissions. Local/staging keep managed certificates.
- Regional deployment statements are conditioned on
  `aws:RequestedRegion=us-west-2`; global IAM and Route 53 statements are
  separate.

- [ ] **Step 2: Run the policy test and verify missing-file failures**

```bash
node --test infra/scripts/bootstrap-policy.test.mjs
```

Expected: failure because the policy files do not yet exist.

- [ ] **Step 3: Add exact KMS, bucket, and OIDC trust policies**

Create a KMS key policy that enables account IAM policies:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EnableAccountIAMPolicies",
    "Effect": "Allow",
    "Principal": {"AWS": "arn:aws:iam::055237683908:root"},
    "Action": "kms:*",
    "Resource": "*"
  }]
}
```

Create a bucket policy with `DenyInsecureTransport`, principal `*`, action
`s3:*`, both bucket ARNs, and condition
`{"Bool":{"aws:SecureTransport":"false"}}`.

Create an OIDC trust policy with the exact provider principal, action
`sts:AssumeRoleWithWebIdentity`, and `StringEquals` conditions for audience
`sts.amazonaws.com` and subject
`repo:uw-ssec/llteacher:environment:production`.

- [ ] **Step 4: Add four focused deployment policies and the runtime boundary**

Create the KMS-parameterized state template, static compute, data/global, and
network policies. Use IAM names `llteacher-production-deploy-state`,
`llteacher-production-deploy-compute`, `llteacher-production-deploy-data`, and
`llteacher-production-deploy-network`. This supersedes the earlier three-policy
split: correct EC2 resource/tag authorization exceeds the single compute/network
policy quota. Preserve readable service statements and test each policy's size.
The separate `llteacher-production-runtime-boundary` is bootstrap-owned, never a
deploy-role grant. It allows only ECR pull/log writes, exact runtime secret reads,
and exact application-bucket access. Require its exact ARN on runtime role creation.

Use these independently reviewable statement groups:

- `PulumiStateList`: `s3:ListBucket` on the exact
  state bucket, with `s3:prefix` limited to `llteacher-infra/.pulumi` and
  `llteacher-infra/.pulumi/*`. Separate `s3:GetBucketLocation` on that exact
  bucket without the unsupported prefix condition.
- `PulumiStateObjects`: `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`,
  and `s3:DeleteObject` on the exact backend object prefix.
- `PulumiStateKms`: `kms:Encrypt`, `kms:Decrypt`, `kms:ReEncrypt*`,
  `kms:GenerateDataKey*`, and `kms:DescribeKey` on `${KMS_KEY_ARN}`.
- `CallerIdentity`: `sts:GetCallerIdentity` on `*`.
- Network policy: `ec2:Describe*`, `ec2:CreateVpc`,
  `ec2:ModifyVpcAttribute`, `ec2:DeleteVpc`, `ec2:CreateInternetGateway`,
  `ec2:AttachInternetGateway`, `ec2:DetachInternetGateway`,
  `ec2:DeleteInternetGateway`, `ec2:CreateRouteTable`,
  `ec2:DeleteRouteTable`, `ec2:CreateRoute`, `ec2:ReplaceRoute`,
  `ec2:DeleteRoute`, `ec2:AssociateRouteTable`,
  `ec2:DisassociateRouteTable`, `ec2:CreateSubnet`,
  `ec2:ModifySubnetAttribute`, `ec2:DeleteSubnet`,
  `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`,
  `ec2:AuthorizeSecurityGroupEgress`, `ec2:RevokeSecurityGroupIngress`,
  `ec2:RevokeSecurityGroupEgress`, `ec2:DeleteSecurityGroup`,
  `ec2:CreateTags`, and `ec2:DeleteTags`, with
  `aws:RequestedRegion=us-west-2`. Only discovery uses `Resource: "*"`.
  Split creates onto exact account/region resource-type ARNs with production
  request ownership tags; separately authorize the owned parent VPC for subnet,
  route-table, and security-group creation. Existing mutations require resource
  ownership tags. Creation tagging requires `ec2:CreateAction` matching the five
  create APIs and production request ownership. Later tagging requires existing
  ownership, a non-null tag-key list, and cannot touch the `LLTeacherStack` key.
  The non-null check blocks DeleteTags with no tag list (which deletes all tags).
  Set these ownership tags
  in production network resources at creation; stop for privileged review before
  adopting existing untagged resources.
- `ElasticLoadBalancing`: `elasticloadbalancing:Describe*`,
  `elasticloadbalancing:CreateLoadBalancer`,
  `elasticloadbalancing:ModifyLoadBalancerAttributes`,
  `elasticloadbalancing:DeleteLoadBalancer`,
  `elasticloadbalancing:CreateTargetGroup`,
  `elasticloadbalancing:ModifyTargetGroup`,
  `elasticloadbalancing:ModifyTargetGroupAttributes`,
  `elasticloadbalancing:DeleteTargetGroup`,
  `elasticloadbalancing:CreateListener`,
  `elasticloadbalancing:ModifyListener`,
  `elasticloadbalancing:DeleteListener`, `elasticloadbalancing:AddTags`, and
  `elasticloadbalancing:RemoveTags`, with the regional condition and LLTeacher
  production resources used wherever ARN scoping is supported.
- `Ecs`: `ecs:CreateCluster`, `ecs:DeleteCluster`, `ecs:DescribeClusters`,
  `ecs:ListClusters`, `ecs:TagResource`, `ecs:UntagResource`,
  `ecs:RegisterTaskDefinition`, `ecs:DeregisterTaskDefinition`,
  `ecs:DescribeTaskDefinition`, `ecs:ListTaskDefinitions`,
  `ecs:CreateService`, `ecs:UpdateService`, `ecs:DeleteService`,
  `ecs:DescribeServices`, `ecs:ListServices`, `ecs:RunTask`, `ecs:StopTask`,
  `ecs:DescribeTasks`, and `ecs:ListTasks`, with the regional condition and
  LLTeacher cluster, service, and task-definition families where supported.
- `EcrAuthorization`: `ecr:GetAuthorizationToken` on `*` with the regional
  condition. `EcrRepository`: `ecr:CreateRepository`, `ecr:DeleteRepository`,
  `ecr:DescribeRepositories`, `ecr:DescribeImages`, `ecr:ListTagsForResource`,
  `ecr:PutLifecyclePolicy`, `ecr:GetLifecyclePolicy`,
  `ecr:DeleteLifecyclePolicy`, `ecr:TagResource`, `ecr:UntagResource`,
  `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`,
  `ecr:BatchGetImage`, `ecr:PutImage`, `ecr:InitiateLayerUpload`,
  `ecr:UploadLayerPart`, and `ecr:CompleteLayerUpload` on
  `arn:aws:ecr:us-west-2:055237683908:repository/llteacher-production/app`.
- `Rds`: `rds:Describe*`, `rds:ListTagsForResource`,
  `rds:AddTagsToResource`, `rds:RemoveTagsFromResource`,
  `rds:CreateDBSubnetGroup`, `rds:ModifyDBSubnetGroup`,
  `rds:DeleteDBSubnetGroup`, `rds:CreateDBInstance`, `rds:ModifyDBInstance`,
  and `rds:DeleteDBInstance`, with the regional condition and
  `llteacher-production-*` resources where supported. `CreateDBInstance` alone
  also permits default PostgreSQL 16 parameter/option groups, never modifying them.
- `ApplicationS3`: `s3:CreateBucket`, `s3:DeleteBucket`, `s3:ListBucket`,
  `s3:GetBucket*`, `s3:GetEncryptionConfiguration`, `s3:GetLifecycleConfiguration`,
  `s3:GetReplicationConfiguration`, `s3:GetAccelerateConfiguration`,
  `s3:PutBucketVersioning`, `s3:PutEncryptionConfiguration`,
  `s3:PutBucketPublicAccessBlock`, `s3:PutLifecycleConfiguration`,
  and `s3:PutBucketTagging` only for
  `arn:aws:s3:::llteacher-production-*` and its objects, with
  `s3:LocationConstraint=us-west-2` on bucket creation.
- `SecretsManager`: `secretsmanager:CreateSecret`,
  `secretsmanager:DeleteSecret`, `secretsmanager:DescribeSecret`,
  `secretsmanager:PutSecretValue`, `secretsmanager:GetSecretValue`, `secretsmanager:TagResource`,
  `secretsmanager:UntagResource`, `secretsmanager:GetResourcePolicy`,
  `secretsmanager:PutResourcePolicy`, and
  `secretsmanager:DeleteResourcePolicy` on
  `arn:aws:secretsmanager:us-west-2:055237683908:secret:llteacher-production-*`.
- `CloudWatchLogs`: `logs:CreateLogGroup`, `logs:DeleteLogGroup`,
  `logs:DescribeLogGroups`, `logs:PutRetentionPolicy`,
  `logs:DeleteRetentionPolicy`, `logs:TagResource`, `logs:UntagResource`, and
  `logs:ListTagsForResource` on actual `llteacher-production-app-logs-*` auto-named
  log group ARNs (including required `:*` forms), with the regional condition.
  `DescribeLogGroups` is a separate wildcard discovery statement.
- `AcmInspect`: only `acm:DescribeCertificate` and `acm:ListTagsForCertificate`,
  with the regional condition, account/region certificate ARNs, and existing
  `LLTeacherStack=production` resource ownership. No ACM listing or writes.
  An operator provisions/tags the certificate and renewal CNAME after domain
  selection and verifies issuance. Production domainReady=true requires the exact
  certificateArn; Pulumi reads the certificate without importing/managing it and
  checks ARN/domain/tag/status before attaching HTTPS. Local/staging preserve
  managed certificates. Document exact operator issue/tag/DNS/wait/verify/config/
  preview commands and the retain/detach gate for already managed production certs.
- `ManageLlteacherRoles`: IAM role and inline-policy lifecycle actions only on
  the execution-role/task-role ARN families above. Split CreateRole to require
  `iam:PermissionsBoundary=arn:aws:iam::055237683908:policy/llteacher-production-runtime-boundary`;
  omit Put/DeleteRolePermissionsBoundary entirely.
- `PassLlteacherTaskRoles`: `iam:PassRole` on those same role families, conditioned
  on `iam:PassedToService=ecs-tasks.amazonaws.com`.
- `ManageLlteacherRoute53`: only the hosted-zone and record-change actions
  needed by the optional LLTeacher production zone; list actions remain the
  smallest unavoidable wildcard set.

Use no deployment-role permission to administer the bootstrap state bucket,
change the KMS key policy, schedule deletion, or modify its own OIDC trust.

- [ ] **Step 5: Run policy structure and JSON parsing tests**

```bash
node --test infra/scripts/bootstrap-policy.test.mjs
for file in infra/bootstrap/*.json; do jq -e . "$file" >/dev/null; done
```

Expected: all tests pass and every policy parses as JSON.

- [ ] **Step 6: Commit the bootstrap policies**

```bash
git add infra/bootstrap infra/scripts/bootstrap-policy.test.mjs
git commit -m "infra: define production bootstrap policies"
```

### Task 4: Document the one-time bootstrap and remove Cloud instructions

**Files:**
- Modify: `infra/README.md`
- Modify: `infra/package.json`
- Modify: `docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md`
- Modify: `docs/superpowers/plans/2026-09-21-minimal-production-infrastructure-implementation.md`
- Modify: `docs/superpowers/plans/2026-09-21-infrastructure-implementation-handoff.md`
- Test: `infra/scripts/release-workflow.test.mjs`
- Test: `infra/scripts/bootstrap-policy.test.mjs`

**Interfaces:**
- Consumes: all eight policy documents from Task 3 (four deployment managed policies, one boundary, key/bucket/trust policies) and the workflow variables from Task 2.
- Produces: an operator procedure that creates/verifies bootstrap resources without printing secrets or creating application resources.

- [ ] **Step 1: Add failing documentation contract assertions**

Extend tests so normative production workflow/operations files must mention the
exact backend, bucket, stack, KMS alias, and OIDC subject and must not mention
`PULUMI_ACCESS_TOKEN` or require an organization-qualified stack. Exclude
historical text only when it contains an explicit supersession notice pointing
to the 2026-09-22 design.

- [ ] **Step 2: Run focused tests and verify documentation assertions fail**

```bash
node --test infra/scripts/release-workflow.test.mjs infra/scripts/bootstrap-policy.test.mjs
```

Expected: failures against the current Pulumi Cloud operations guide.

- [ ] **Step 3: Replace Pulumi Cloud setup in the operations guide**

Update `infra/README.md` to document, in order:

1. Export fixed non-secret names and create an owner-only temporary directory
   with `umask 077` and `mktemp -d`.
2. Reconfirm `aws sts get-caller-identity --profile default` returns account
   `055237683908` and configured region is `us-west-2`.
3. Read-only existence checks for KMS alias, state bucket, OIDC provider, role,
   and policies.
4. Create the KMS key from the checked-in key policy, capture its ARN without
   printing secret material, create the alias, enable rotation, and verify key
   state, alias, rotation, and policy.
5. Create the regional bucket only if absent; set bucket-owner-enforced
   ownership, all public-access blocks, versioning, default SSE-KMS, TLS policy,
   and tags; verify every setting independently.
6. Reuse the OIDC provider when present or create it with audience
   `sts.amazonaws.com` when absent; verify issuer and client IDs.
7. Create the deployment role from the checked-in trust policy only if absent;
   otherwise compare the live trust policy before updating it.
8. Render `${KMS_KEY_ARN}` from the checked-in permission template into the
   owner-only temporary directory with `jq --arg`, print the non-secret final
   JSON for review, create/update the managed policy, attach it to the role,
   and verify attachment plus policy version.
9. Configure GitHub environment variables `AWS_DEPLOY_ROLE_ARN`,
   `PULUMI_BACKEND_URL`, and `PULUMI_STACK=production`; explicitly state that
   no Pulumi access token is used.
10. Export `AWS_PROFILE=default`, `AWS_REGION=us-west-2`, and the exact backend;
    run `pulumi login`, then initialize `production` with secrets provider
    `awskms://alias/llteacher-pulumi-state?region=us-west-2&awssdk=v2`.
    Keep the profile in the local operator environment only; never persist a
    profile query parameter, which would override GitHub OIDC environment credentials.
11. Set non-secret configuration and use hidden input or secure stdin for
    `databasePassword` and `runtimeSecrets`; never copy local development
    credentials automatically.
12. Run `pulumi preview` only and stop for cost/security review and explicit
    apply authorization.

Every create/update command must be visually separated from its preceding
read-only check and following verification. Document stop conditions for a
foreign bucket, mismatched key/alias, mismatched OIDC provider, unexpected role
trust, partial creation, wrong account/region/backend, and unexpected preview.

- [ ] **Step 4: Update package and historical documentation references**

Replace `pulumi:cloud` in `infra/package.json` with a production helper that
builds infrastructure and targets the exact S3 backend and stack without setting
a profile or secret:

```json
"pulumi:production": "npm run build && PULUMI_BACKEND_URL=s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra AWS_REGION=us-west-2 pulumi --stack production"
```

Update the prior design where it remains normative. At the top of historical
implementation/handoff documents, add a clear backend supersession note pointing
to `docs/superpowers/specs/2026-09-22-s3-pulumi-backend-design.md`; do not rewrite
historical test results or implementation chronology.

- [ ] **Step 5: Run documentation and release contracts**

```bash
node --test infra/scripts/release-workflow.test.mjs infra/scripts/bootstrap-policy.test.mjs
rg -n 'PULUMI_ACCESS_TOKEN|organization/llteacher-infra/production|pulumi:cloud' .github infra/README.md infra/package.json
```

Expected: tests pass; the search returns no operational Pulumi Cloud references.

- [ ] **Step 6: Commit the operator documentation**

```bash
git add infra/README.md infra/package.json docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md docs/superpowers/plans/2026-09-21-minimal-production-infrastructure-implementation.md docs/superpowers/plans/2026-09-21-infrastructure-implementation-handoff.md infra/scripts/release-workflow.test.mjs infra/scripts/bootstrap-policy.test.mjs
git commit -m "docs: add S3 backend bootstrap procedure"
```

### Task 5: Run final verification and update PR #461

**Files:**
- Verify: all files changed in Tasks 1–4
- Modify only if verification finds a defect: the owning task's files and tests

**Interfaces:**
- Consumes: completed commits from Tasks 1–4.
- Produces: a clean, pushed PR branch whose hosted checks can validate the S3 backend changes without creating AWS resources.

- [ ] **Step 1: Run focused infrastructure verification**

```bash
npm run typecheck --workspace=infra
npm run build --workspace=infra
npm test --workspace=infra
bash infra/scripts/bootstrap-aws-infra.test.sh
bash infra/scripts/release-workflow.test.sh
bash infra/scripts/run-aws-migrations.test.sh
```

Expected: all commands pass.

- [ ] **Step 2: Run repository contract and formatting checks**

```bash
git diff --check origin/ksdani/infra-production-simplification...HEAD
for file in infra/bootstrap/*.json; do jq -e . "$file" >/dev/null; done
rg -n 'PULUMI_ACCESS_TOKEN|organization/llteacher-infra/production|pulumi:cloud' .github infra/README.md infra/package.json
git status --short --branch
```

Expected: no whitespace or JSON errors, no operational Cloud references, and a
clean branch ahead only by the intended commits.

- [ ] **Step 3: Review the full branch diff for secret and scope safety**

```bash
git diff --stat 76f7f25...HEAD
git diff --check 76f7f25...HEAD
git grep -nE 'AKIA[0-9A-Z]{16}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|WORKOS_API_KEY=|LLMOXIE_API_KEY=' -- . ':!package-lock.json'
```

Expected: only planned workflow, helper, policy, test, and documentation files;
no credential material. Any grep hit must be an existing variable name or test
fixture without a real value and must be reviewed before proceeding.

- [ ] **Step 4: Obtain final code review before push**

Use the repository's code-review workflow against `76f7f25` and resolve any
correctness, security, or spec findings. Re-run the owning task's focused tests
and the final verification after each fix.

- [ ] **Step 5: Push the implementation to the existing PR branch**

```bash
git push origin ksdani/infra-production-simplification
```

Expected: PR #461 updates; no workflow deploys because this is a branch push,
not a version tag.

- [ ] **Step 6: Observe hosted checks without dispatching production**

```bash
gh pr checks 461 --watch
```

Expected: ordinary PR checks complete successfully. Do not merge, create a tag,
dispatch `release.yml`, create AWS resources, or run production `pulumi up`.
