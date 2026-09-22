# Minimal AWS stack and developer-local Floci

Production provisioning still requires the release owner's explicit approval.
This branch prepares the configuration; running local commands does not authorize
an AWS deployment.

## What runs

One Node 24/Hono ECS Fargate task serves the student app (`/`), instructor
console (`/admin`) and API (`/api`). All regional resources use **us-west-2**.

| Resources | Purpose |
| --- | --- |
| VPC, internet gateway, public route table, two public subnets/associations | ALB and app egress without a NAT gateway. |
| Two private database subnets and DB subnet group | Keep RDS inaccessible from the internet. |
| Three security groups | Internet → ALB → app:8080 → database:5432; no public app-port ingress. |
| ALB, target group, listener | One origin and task health/routing. HTTP for bootstrap; HTTPS when domain-ready. |
| Optional managed Route 53 zone, ACM certificate/validation records, alias | Domain ownership and trusted TLS after selecting/delegating a domain. |
| ECS cluster, task definition, one service/task; ECR repository | Managed compute and immutable AWS release images. |
| RDS PostgreSQL 16, encrypted 20 GiB storage | Application data; pgvector initialized by migrations, seven-day production backups. |
| One private, encrypted, versioned S3 bucket and its safeguards | Uploaded originals and durable knowledge snapshots. |
| Two Secrets Manager secrets/versions | Database connection and structured application credentials. |
| Execution/task IAM roles, execution-policy attachment, scoped secret/S3 policies | Pull image, write logs, inject secrets, access course objects. |
| One CloudWatch log group | Bounded application logs. |

IAM and Route 53 are global. No NAT/EIP, CloudFront, SQS/DLQ, EventBridge,
separate worker, scheduled ECS task, Redis, or EFS is created. The main recurring
costs are ALB, one Fargate task, RDS, and stored data—not each control-plane
object.

The overdue sweep runs at startup and hourly, with a same-session PostgreSQL
advisory lock. Extraction remains in-process; interrupted work is visible and
retryable. Knowledge files use an S3-backed snapshot with a temporary OKF
working copy. Scaling to multiple app tasks is not supported by this release.
Replacement stops the old app before starting the new one, so releases cause
brief downtime. Migrations complete before that replacement.

The public app subnets, public task IP, and unrestricted outbound security-group
rule are an intentional NAT-free cost tradeoff for this first production shape.
Ingress still flows only through the ALB, and RDS remains private. This does not
provide an outbound network choke point; VPC endpoints, Flow Logs, and tighter
egress remain deferred compensating controls that must be revisited before the
threat model or scale changes.

When switching an existing filesystem knowledge store to S3, migrate it
explicitly first. A nonempty local course without a remote snapshot is refused
rather than silently deleted or uploaded. Fresh temporary working roots restore
normally; do not point production at an unreviewed legacy directory.

## Run locally

Prerequisites: Docker Desktop, Node 24/npm, Pulumi CLI, AWS CLI v2, jq, curl,
OpenSSL and Bash. From repository root:

```sh
npm ci
npm run aws:local:up
npm run aws:local:verify
```

- App: [http://localhost:8080](http://localhost:8080)
- Instructor console: [http://localhost:8080/admin](http://localhost:8080/admin)
- Health/version: [http://localhost:8080/api/health](http://localhost:8080/api/health)
- Emulator API: [http://localhost:4566](http://localhost:4566)

Floci 2.1.0 creates the actual ECS- and RDS-backed Docker containers. There is no
directly launched substitute app/database and no Caddy TLS proxy. Pulumi uses
the same conditional resource graph for the same domain/service configuration
in local and AWS environments. Floci's ALB data plane uses HTTP, even when an
HTTPS listener is modeled; it cannot prove real TLS, IAM isolation, public DNS,
or AWS networking enforcement. Those require real-AWS verification.

The committed local example leaves `domainReady=false`, so the normal bootstrap
origin is `http://localhost:8080`. If an existing local stack explicitly has
`domainReady=true`, the launcher preserves that resource graph and derives
`APP_URL` plus smoke checks from Floci's plaintext port 8443 mapping. This tests
the conditional listener graph only; it does not establish local or AWS TLS.

Local state lives in ignored `.floci/data`, `.pulumi/local`,
`infra/Pulumi.local.yaml`, and the owner-only `.floci/pulumi-passphrase`.
Retain them together. Do not delete volumes/state or run `pulumi destroy` as
a troubleshooting shortcut.

`aws:local:down` stops local runtime containers without deleting database
volumes. The launcher uses a replaceable `:local` image, a dedicated build
cache with a 2 GiB retention target, and scoped unused-image cleanup. It never
globally prunes Docker data. Image/cache size reports can share underlying
layers and should not simply be added together.

Local placeholder credentials allow infrastructure/boot tests only. They do
**not** enable real WorkOS login or LLM calls. Supply development credentials
through encrypted local Pulumi configuration and register
`http://localhost:8080/api/auth/callback` in the WorkOS development environment.
Do not put credentials in shell history, chat, source code, or Docker build args.

## Secrets and normal configuration

The encrypted Pulumi secret `databasePassword` creates the database URL secret.
The encrypted `runtimeSecrets` JSON object contains:

```text
WORKOS_API_KEY
WORKOS_CLIENT_ID
WORKOS_WEBHOOK_SECRET
OPENROUTER_API_KEY
LLMOXIE_API_KEY
SESSION_SECRET
ENCRYPTION_KEY
BLIND_INDEX_KEY
```

Use `pulumi config set --secret databasePassword --stack <stack>` for a
hidden interactive prompt. Load runtime JSON via secure stdin from an owner-only
file, not a command-line argument or checked-in plaintext file. Pulumi state
and stack configuration contain ciphertext; protect access to their backend.

ECS reads these values using the **execution role**, which has
`secretsmanager:GetSecretValue` for exactly those two secret ARNs. The app
receives normal environment variables and does not fetch the secrets itself.
The **task role** accesses S3 through the AWS SDK credential chain; production
has no static storage access keys. Its object access and bucket listing are
limited to `courses/*/materials/*` and `courses/*/knowledge/*`. This is one
shared application role across every course, not an IAM tenant boundary and not
per-course isolation. Course authorization remains an application concern.
Production database connections verify the RDS TLS certificate using the
regional CA bundle included in the image.

Normal app tasks do not receive `s3:GetObjectVersion` or
`s3:ListBucketVersions`. An operator performing recovery should assume a
separate, temporary role limited to the production materials bucket. Grant
`s3:GetBucketVersioning` on that bucket; grant `s3:ListBucket` and
`s3:ListBucketVersions` on the bucket conditioned to the affected
`courses/<course-id>/knowledge/*` prefix; and grant `s3:GetObject`,
`s3:GetObjectVersion`, and `s3:PutObject` only on objects under that prefix.
Remove the temporary grant after the reviewed recovery. Do not add
version-history access to the shared app task role.

`APP_URL`, `AWS_REGION`, `STORAGE_BUCKET`, `KNOWLEDGE_ROOT`, `PORT`
and `BUILD_SHA` are ordinary configuration. WorkOS builds the authorization
URL; its registered callback must be `${APP_URL}/api/auth/callback`.
Updating a secret does not update an already running process: replace/redeploy
the task after rotation.

## GitHub Actions: AWS releases only

`.github/workflows/test.yml` remains ordinary code CI. `release.yml` runs
build/tests and deploys to AWS, never Floci. Production runs only from release
tags (including manual dispatch on a tag) and uses a protected GitHub
`production` environment. Configure required reviewers and tag restrictions
in GitHub before enabling the first release.

This intentionally removes the former push-to-`staging` auto-deploy path:
branch pushes do not deploy any AWS environment. Automated release support is
production-only; adding another environment requires a separately reviewed
release design rather than changing `STACK`.

Required GitHub configuration:

| Kind | Name | Value |
| --- | --- | --- |
| Environment variable | `AWS_DEPLOY_ROLE_ARN` | ARN of the GitHub OIDC deployment role. |
| Environment variable | `PULUMI_BACKEND_URL` | `s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra` |
| Environment variable | `PULUMI_STACK` | `production` |

No AWS access keys, database URL, WorkOS keys, provider keys or application
cryptographic keys belong in GitHub secrets. The separate test job uses
disposable PostgreSQL credentials and ephemeral test encryption keys.

The deployment job installs/builds Pulumi, authenticates through GitHub OIDC,
validates the AWS account and exact S3 backend, selects stack `production`,
refreshes encrypted stack configuration, bootstraps ECR only if absent,
loads the test job's checksum-verified image artifact, publishes that same image
and resolves its digest. It previews/registers a
candidate while retaining the current service task definition, runs that exact
candidate as a one-off ECS migration, activates it only after success, waits
for stability and checks that health reports the expected commit. Failed
migration stops activation. Releases are serialized.

After refresh and before the first AWS mutation, the workflow verifies that the
S3 stack still says `aws:region=us-west-2`, `environment=production`, and has
a valid `domainName` with `domainReady=true`. Base infrastructure may be
bootstrapped without a domain while `deployApp=false`; the production app cannot
be activated until HTTPS is ready. Local Floci remains HTTP-capable.

`run-aws-migrations.sh` now requires exactly two positional arguments: the
stack `production` and the immutable candidate task-definition ARN. Use the
verified production AWS session and backend from the bootstrap procedure:

```sh
bash infra/scripts/run-aws-migrations.sh \
  production \
  arn:aws:ecs:us-west-2:055237683908:task-definition/llteacher-production-app:7
```

There is no legacy environment-variable fallback. A terminal task whose app
container never started is diagnosed and retried within the configured bound.
A waiter timeout or any task not confirmed `STOPPED` aborts without launching a
second migration task.

### Existing-stack region precheck

Before the first workflow run against a stack created by an older revision,
refresh and inspect it without changing configuration:

```sh
export AWS_PROFILE=default AWS_REGION=us-west-2 STACK=production
export PULUMI_BACKEND_URL=s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra
test "$(aws sts get-caller-identity --profile default --region us-west-2 --query Account --output text)" = 055237683908 || exit 1
pulumi login "$PULUMI_BACKEND_URL"
pulumi -C infra config refresh --stack "$STACK" --non-interactive
pulumi -C infra config get aws:region --stack "$STACK"
pulumi -C infra stack --stack "$STACK" --show-urns
```

If the region is `us-east-1` and the stack has resources, stop. Do **not** run a
blind `pulumi config set aws:region us-west-2`: that changes provider targeting
without migrating the existing regional resources. Inventory the state and AWS
resources, decide whether to retain/import or replace each resource, preserve
the database and S3 data explicitly, and execute a reviewed migration plan with
rollback before enabling release automation. Only an empty stack may be safely
reconfigured directly to `us-west-2`.

### One-time account/stack bootstrap (after explicit approval)

The [2026-09-22 design](../docs/superpowers/specs/2026-09-22-s3-pulumi-backend-design.md)
is authoritative. These are reviewed operator commands, not an unattended
bootstrap script. Run blocks in order from the repository root in a dedicated
Bash session. Each **Read-only check**, **Mutation**, and **Verification** is a
separate operator step. Execute mutations only after reviewing the preceding
check. A mismatch or partial creation means **stop**, preserve the resources,
and reconcile with the release owner; never delete/recreate to retry. Do not
enable release tags until all verifications below succeed.

#### 1. Fixed names and caller identity

Start a fresh Bash session, turn off tracing, and prepare owner-only files.
All AWS commands below use `default`; the `aws_bootstrap` shorthand fixes both
profile and region, including for global IAM APIs. No credentials are printed.
Remove inherited endpoint/credential overrides so local emulator settings or
ambient credentials cannot silently change the target.

```bash
bash
```

```bash
set +x
set -euo pipefail
umask 077
export AWS_PROFILE=default AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true AWS_PAGER=''
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset AWS_ENDPOINT_URL AWS_ENDPOINT_URL_S3 AWS_ENDPOINT_URL_STS AWS_ENDPOINT_URL_KMS AWS_ENDPOINT_URL_IAM
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN PULUMI_CONFIG_PASSPHRASE PULUMI_CONFIG_PASSPHRASE_FILE
export ACCOUNT_ID=055237683908 STATE_BUCKET=llteacher-pulumi-state-055237683908-us-west-2
export KMS_ALIAS=alias/llteacher-pulumi-state DEPLOY_ROLE=llteacher-production-deploy
export PULUMI_BACKEND_URL=s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra
export PULUMI_STACK=production
export OIDC_ARN=arn:aws:iam::055237683908:oidc-provider/token.actions.githubusercontent.com
export BOUNDARY_ARN=arn:aws:iam::055237683908:policy/llteacher-production-runtime-boundary
BOOTSTRAP_TMP=$(mktemp -d "${TMPDIR:-/tmp}/llteacher-bootstrap.XXXXXXXX")
chmod 700 "$BOOTSTRAP_TMP"
aws_bootstrap() { aws --profile default --region us-west-2 --output json "$@"; }
stop() { printf '%s\n' "$*" >&2; exit 1; }
# Read helper: only the named absence code is allowed; denial/network errors stop.
read_optional() {
  local absence=$1 destination=$2
  shift 2
  if aws_bootstrap "$@" >"$destination" 2>"$BOOTSTRAP_TMP/read-error"; then
    return 0
  fi
  if grep -Fq "($absence)" "$BOOTSTRAP_TMP/read-error"; then
    return 1
  fi
  cat "$BOOTSTRAP_TMP/read-error" >&2
  stop 'Read failed; do not interpret this as absence.'
}
same_json() { diff -u <(jq -S . "$1") <(jq -S . "$2"); }
```

**Read-only check and verification:** confirm the configured region before any
mutation; explicitly selecting a region is not a substitute for this check.

```bash
test "$(aws configure get region --profile default)" = us-west-2 || stop 'Wrong configured region.'
aws sts get-caller-identity --profile default --region us-west-2 --output json >"$BOOTSTRAP_TMP/caller.json"
jq -e '.Account == "055237683908"' "$BOOTSTRAP_TMP/caller.json"
jq '{Account, Arn}' "$BOOTSTRAP_TMP/caller.json"
test "$PULUMI_BACKEND_URL" = s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra
test "$PULUMI_STACK" = production
```

Confirm that the displayed principal is the approved bootstrap operator. Stop
for the wrong account, profile, region, backend, stack, or unexpected principal.

#### 2. Read-only inventory before creation

Only `NotFoundException`, `404`, and `NoSuchEntity` from their respective
checks mean absent. A bucket `403` can mean a foreign bucket: stop, do not
choose another name or try to take it over. A newly approved name would require
re-review of the backend, policies, and workflow.

```bash
if read_optional NotFoundException "$BOOTSTRAP_TMP/key.json" kms describe-key --key-id "$KMS_ALIAS"; then KMS_EXISTS=true; else KMS_EXISTS=false; fi
if read_optional 404 "$BOOTSTRAP_TMP/bucket.json" s3api head-bucket --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"; then BUCKET_EXISTS=true; else BUCKET_EXISTS=false; fi
if read_optional NoSuchEntity "$BOOTSTRAP_TMP/oidc.json" iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN"; then OIDC_EXISTS=true; else OIDC_EXISTS=false; fi
if read_optional NoSuchEntity "$BOOTSTRAP_TMP/role.json" iam get-role --role-name "$DEPLOY_ROLE"; then ROLE_EXISTS=true; else ROLE_EXISTS=false; fi
for policy_name in llteacher-production-runtime-boundary llteacher-production-deploy-state llteacher-production-deploy-compute llteacher-production-deploy-data; do
  if read_optional NoSuchEntity "$BOOTSTRAP_TMP/$policy_name.json" iam get-policy --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$policy_name"; then
    jq '.Policy | {Arn, DefaultVersionId, AttachmentCount}' "$BOOTSTRAP_TMP/$policy_name.json"
  else
    printf 'Absent managed policy: %s\n' "$policy_name"
  fi
done
```

If the bucket exists but the alias does not, or another resource suggests a
partially completed bootstrap, stop and reconcile existing key IDs and policy
versions. Do not mint a replacement key for active state. A KMS alias alone
does not establish that its target is the intended key: reconcile its ARN with
the bootstrap record and existing bucket encryption before reuse.

#### 3. KMS key and alias

**Read-only check:** review the inventory, existing key metadata (when present),
and `infra/bootstrap/pulumi-state-kms-key-policy.json`. For an existing key,
set `KMS_KEY_ARN` from the metadata and proceed directly to verification.

```bash
jq . infra/bootstrap/pulumi-state-kms-key-policy.json
if test "$KMS_EXISTS" = true; then
  KMS_KEY_ARN=$(jq -er '.KeyMetadata.Arn' "$BOOTSTRAP_TMP/key.json")
fi
```

**Mutation — only if the alias and key are confirmed absent:**

```bash
if test "$KMS_EXISTS" = false; then
  test "$BUCKET_EXISTS" = false || stop 'Existing bucket without known key: reconcile first.'
  aws_bootstrap kms create-key --description 'LLTeacher production Pulumi state and secrets' \
    --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
    --policy file://infra/bootstrap/pulumi-state-kms-key-policy.json \
    --tags TagKey=Project,TagValue=llteacher TagKey=Environment,TagValue=production TagKey=ManagedBy,TagValue=bootstrap \
    >"$BOOTSTRAP_TMP/created-key.json"
  KMS_KEY_ARN=$(jq -er '.KeyMetadata.Arn' "$BOOTSTRAP_TMP/created-key.json")
fi
```

**Verification:** persist this non-secret ARN in the bootstrap record immediately;
if any later step fails, use it to reconcile rather than creating another key.

```bash
export KMS_KEY_ARN
[[ "$KMS_KEY_ARN" == arn:aws:kms:us-west-2:055237683908:key/* ]] || stop 'Wrong key ARN.'
aws_bootstrap kms describe-key --key-id "$KMS_KEY_ARN" >"$BOOTSTRAP_TMP/key.json"
jq -e --arg arn "$KMS_KEY_ARN" '.KeyMetadata | .Arn == $arn and .AWSAccountId == "055237683908" and .KeyState == "Enabled" and .KeyManager == "CUSTOMER" and .KeyUsage == "ENCRYPT_DECRYPT" and .KeySpec == "SYMMETRIC_DEFAULT"' "$BOOTSTRAP_TMP/key.json"
printf 'Record KMS key ARN: %s\n' "$KMS_KEY_ARN"
```

**Read-only check:** enumerate aliases and confirm either an exact target match
or absence. A different target is a stop condition, never an alias update.

```bash
aws_bootstrap kms list-aliases >"$BOOTSTRAP_TMP/aliases.json"
jq --arg alias "$KMS_ALIAS" '.Aliases[] | select(.AliasName == $alias)' "$BOOTSTRAP_TMP/aliases.json"
```

**Mutation — only for the new key:**

```bash
if test "$KMS_EXISTS" = false; then
  jq -e --arg alias "$KMS_ALIAS" '[.Aliases[] | select(.AliasName == $alias)] | length == 0' "$BOOTSTRAP_TMP/aliases.json"
  aws_bootstrap kms create-alias --alias-name "$KMS_ALIAS" --target-key-id "$KMS_KEY_ARN"
fi
```

**Verification:**

```bash
test "$(aws_bootstrap kms describe-key --key-id "$KMS_ALIAS" --query KeyMetadata.Arn --output text)" = "$KMS_KEY_ARN" || stop 'Mismatched key/alias.'
```

**Read-only check:**

```bash
aws_bootstrap kms get-key-rotation-status --key-id "$KMS_KEY_ARN" >"$BOOTSTRAP_TMP/rotation.json"
```

**Mutation — enable rotation for a new key; existing unexpected settings stop:**

```bash
if test "$KMS_EXISTS" = false; then
  aws_bootstrap kms enable-key-rotation --key-id "$KMS_KEY_ARN"
else
  jq -e '.KeyRotationEnabled == true' "$BOOTSTRAP_TMP/rotation.json" || stop 'Review existing key rotation mismatch.'
fi
```

**Verification — rotation and exact policy:**

```bash
aws_bootstrap kms get-key-rotation-status --key-id "$KMS_KEY_ARN" | jq -e '.KeyRotationEnabled == true'
aws_bootstrap kms get-key-policy --key-id "$KMS_KEY_ARN" --policy-name default --query Policy --output text >"$BOOTSTRAP_TMP/key-policy.json"
same_json infra/bootstrap/pulumi-state-kms-key-policy.json "$BOOTSTRAP_TMP/key-policy.json" || stop 'Unexpected key policy.'
```

#### 4. State bucket

**Read-only check:** review the `head-bucket` inventory from step 2. Recheck
immediately before creation to catch a changed or foreign bucket.

```bash
if read_optional 404 "$BOOTSTRAP_TMP/bucket.json" s3api head-bucket --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"; then
  test "$BUCKET_EXISTS" = true || stop 'Bucket appeared after inventory; reconcile.'
else
  test "$BUCKET_EXISTS" = false || stop 'Bucket disappeared after inventory.'
fi
```

**Mutation — create only if absent:**

```bash
if test "$BUCKET_EXISTS" = false; then
  aws_bootstrap s3api create-bucket --bucket "$STATE_BUCKET" \
    --create-bucket-configuration LocationConstraint=us-west-2 --object-ownership BucketOwnerEnforced
fi
```

**Verification:**

```bash
aws_bootstrap s3api head-bucket --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"
test "$(aws_bootstrap s3api get-bucket-location --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --query LocationConstraint --output text)" = us-west-2 || stop 'Wrong bucket region.'
```

For each setting below, check first, mutate **only a bucket created in this
session**, then verify independently. Existing buckets must already match;
stop for any mismatch and obtain a reviewed repair. The grouped blocks have
separate check/mutation/verification portions; do not skip a failed check.

```bash
# Read-only check
aws_bootstrap s3api get-bucket-ownership-controls --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" >"$BOOTSTRAP_TMP/ownership.json"

# Mutation (new bucket only)
if test "$BUCKET_EXISTS" = false; then
  aws_bootstrap s3api put-bucket-ownership-controls --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
fi

# Verification
aws_bootstrap s3api get-bucket-ownership-controls --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" | jq -e '.OwnershipControls.Rules == [{"ObjectOwnership":"BucketOwnerEnforced"}]'
```

```bash
# Read-only check (a new bucket may have no explicit block configuration)
if read_optional NoSuchPublicAccessBlockConfiguration "$BOOTSTRAP_TMP/public-access.json" s3api get-public-access-block --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"; then :; else test "$BUCKET_EXISTS" = false || stop 'Missing public access block.'; fi

# Mutation (new bucket only)
if test "$BUCKET_EXISTS" = false; then
  aws_bootstrap s3api put-public-access-block --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

# Verification
aws_bootstrap s3api get-public-access-block --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" | jq -e '.PublicAccessBlockConfiguration == {"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}'
```

```bash
# Read-only check
aws_bootstrap s3api get-bucket-versioning --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"

# Mutation (new bucket only)
if test "$BUCKET_EXISTS" = false; then
  aws_bootstrap s3api put-bucket-versioning --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --versioning-configuration Status=Enabled
fi

# Verification
aws_bootstrap s3api get-bucket-versioning --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" | jq -e '.Status == "Enabled"'
```

```bash
# Read-only check
aws_bootstrap s3api get-bucket-encryption --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"
jq -n --arg key "$KMS_KEY_ARN" '{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:"aws:kms",KMSMasterKeyID:$key},BucketKeyEnabled:false}]}' >"$BOOTSTRAP_TMP/encryption.json"

# Mutation (new bucket only)
if test "$BUCKET_EXISTS" = false; then
  aws_bootstrap s3api put-bucket-encryption --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --server-side-encryption-configuration "file://$BOOTSTRAP_TMP/encryption.json"
fi

# Verification
aws_bootstrap s3api get-bucket-encryption --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" | jq '.ServerSideEncryptionConfiguration' >"$BOOTSTRAP_TMP/live-encryption.json"
same_json "$BOOTSTRAP_TMP/encryption.json" "$BOOTSTRAP_TMP/live-encryption.json" || stop 'Wrong bucket key/encryption.'
```

```bash
# Read-only check
if read_optional NoSuchBucketPolicy "$BOOTSTRAP_TMP/bucket-policy-response.json" s3api get-bucket-policy --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"; then :; else test "$BUCKET_EXISTS" = false || stop 'Missing TLS policy.'; fi
jq . infra/bootstrap/pulumi-state-bucket-policy.json

# Mutation (new bucket only)
if test "$BUCKET_EXISTS" = false; then
  aws_bootstrap s3api put-bucket-policy --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --policy file://infra/bootstrap/pulumi-state-bucket-policy.json
fi

# Verification
aws_bootstrap s3api get-bucket-policy --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --query Policy --output text >"$BOOTSTRAP_TMP/live-bucket-policy.json"
same_json infra/bootstrap/pulumi-state-bucket-policy.json "$BOOTSTRAP_TMP/live-bucket-policy.json" || stop 'Unexpected bucket policy.'
```

```bash
# Read-only check
if read_optional NoSuchTagSet "$BOOTSTRAP_TMP/bucket-tags.json" s3api get-bucket-tagging --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"; then :; else test "$BUCKET_EXISTS" = false || stop 'Missing bootstrap tags.'; fi

# Mutation (new bucket only)
if test "$BUCKET_EXISTS" = false; then
  aws_bootstrap s3api put-bucket-tagging --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" --tagging 'TagSet=[{Key=Project,Value=llteacher},{Key=Environment,Value=production},{Key=ManagedBy,Value=bootstrap}]'
fi

# Verification
aws_bootstrap s3api get-bucket-tagging --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID" | jq -e '(.TagSet | from_entries) as $tags | $tags.Project == "llteacher" and $tags.Environment == "production" and $tags.ManagedBy == "bootstrap"'
if read_optional NoSuchLifecycleConfiguration "$BOOTSTRAP_TMP/lifecycle.json" s3api get-bucket-lifecycle-configuration --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"; then
  stop 'Unexpected lifecycle configuration; review before continuing.'
fi
```

Do not add lifecycle expiration for current/noncurrent state versions. Never
delete state versions, locks, or the bucket as a recovery shortcut.

#### 5. Account-wide GitHub OIDC provider

**Read-only check:** inspect the existing provider when present. Reuse it;
other applications may share it. Require the exact issuer and STS audience;
review any extra client IDs without removing them.

```bash
if test "$OIDC_EXISTS" = true; then
  jq -e '.Url == "token.actions.githubusercontent.com" and (.ClientIDList | index("sts.amazonaws.com") != null)' "$BOOTSTRAP_TMP/oidc.json" || stop 'Mismatched OIDC provider.'
  jq '{Url, ClientIDList, ThumbprintList}' "$BOOTSTRAP_TMP/oidc.json"
fi
```

**Mutation — only if absent:**

```bash
if test "$OIDC_EXISTS" = false; then
  aws_bootstrap iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
fi
```

**Verification:**

```bash
aws_bootstrap iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >"$BOOTSTRAP_TMP/oidc.json"
jq -e '.Url == "token.actions.githubusercontent.com" and (.ClientIDList | index("sts.amazonaws.com") != null)' "$BOOTSTRAP_TMP/oidc.json" || stop 'Mismatched OIDC provider.'
```

The [AWS CLI provider command](https://docs.aws.amazon.com/cli/latest/reference/iam/create-open-id-connect-provider.html)
can retrieve the thumbprint when omitted; do not paste a guessed certificate
thumbprint. An existing provider mismatch requires account-owner review.

#### 6. Render and review all four managed policies

There are **three deployment policies** (state, compute, data/global), each
below AWS's 6,144-character managed-policy limit, plus the separate runtime
permissions boundary. Do not combine them into an inline deployment policy.
The boundary `llteacher-production-runtime-boundary` must exist **before any
Pulumi production role creation**. It is never attached as a deploy-role grant.

Only `${KMS_KEY_ARN}` is substituted in the state template. These files contain
non-secret permission JSON; displaying them is required for policy review.

```bash
jq --arg key "$KMS_KEY_ARN" 'walk(if type == "string" and . == "${KMS_KEY_ARN}" then $key else . end)' \
  infra/bootstrap/github-deploy-policy.template.json >"$BOOTSTRAP_TMP/deploy-state.json"
jq -e '[.. | strings | select(contains("${"))] | length == 0' "$BOOTSTRAP_TMP/deploy-state.json"
POLICY_NAMES=(llteacher-production-runtime-boundary llteacher-production-deploy-state llteacher-production-deploy-compute llteacher-production-deploy-data)
POLICY_FILES=(infra/bootstrap/runtime-permissions-boundary.json "$BOOTSTRAP_TMP/deploy-state.json" infra/bootstrap/github-compute-policy.json infra/bootstrap/github-data-policy.json)
for policy_file in "${POLICY_FILES[@]}"; do
  test "$(jq -c . "$policy_file" | tr -d '\n' | wc -m | tr -d ' ')" -le 6144 || stop 'Oversized managed policy.'
  jq . "$policy_file"
done
```

Review the EC2 discovery actions scoped to `us-west-2` with wildcard resources
and the Route 53 hosted-zone wildcard `arn:aws:route53:::hostedzone/*` as
explicit scope exceptions. Route 53 permits changes across the account's hosted
zones and cannot be restricted by the application's zone name here. IAM
lifecycle and `iam:PassRole` cover only `llteacher-production-execution-role-*`
and `llteacher-production-task-role-*`, excluding the deployment role.

Repeat the following check/mutation/verification blocks for `POLICY_INDEX=0`,
then `1`, `2`, and `3`, in that order. Do not run them as an unattended loop.

**Read-only check:**

```bash
POLICY_INDEX=0 # repeat with 1, 2, then 3 only after verifying the preceding policy
POLICY_NAME=${POLICY_NAMES[$POLICY_INDEX]}
POLICY_FILE=${POLICY_FILES[$POLICY_INDEX]}
POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME"
if read_optional NoSuchEntity "$BOOTSTRAP_TMP/policy.json" iam get-policy --policy-arn "$POLICY_ARN"; then
  POLICY_EXISTS=true
  VERSION_ID=$(jq -er '.Policy.DefaultVersionId' "$BOOTSTRAP_TMP/policy.json")
  aws_bootstrap iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$VERSION_ID" --query PolicyVersion.Document >"$BOOTSTRAP_TMP/live-policy.json"
  same_json "$POLICY_FILE" "$BOOTSTRAP_TMP/live-policy.json" || stop 'Unexpected managed policy; review a privileged update before resuming.'
else
  POLICY_EXISTS=false
fi
```

**Mutation — create only if absent; identical policies are reused:**

```bash
if test "$POLICY_EXISTS" = false; then
  aws_bootstrap iam create-policy --policy-name "$POLICY_NAME" --policy-document "file://$POLICY_FILE"
fi
```

**Verification — attachment is done later:**

```bash
VERSION_ID=$(aws_bootstrap iam get-policy --policy-arn "$POLICY_ARN" --query Policy.DefaultVersionId --output text)
aws_bootstrap iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$VERSION_ID" --query PolicyVersion.Document >"$BOOTSTRAP_TMP/live-policy.json"
same_json "$POLICY_FILE" "$BOOTSTRAP_TMP/live-policy.json" || stop 'Policy version verification failed.'
```

If a mismatched policy needs an explicitly reviewed update, stop the normal
bootstrap. An authorized owner may use this separate repair sequence after
reviewing the diff and all entities affected by the policy. Never silently
replace a boundary already used by running roles.

**Read-only check for an approved policy repair:**

```bash
aws_bootstrap iam list-entities-for-policy --policy-arn "$POLICY_ARN"
aws_bootstrap iam list-policy-versions --policy-arn "$POLICY_ARN" >"$BOOTSTRAP_TMP/versions.json"
jq -e '.Versions | length < 5' "$BOOTSTRAP_TMP/versions.json" || stop 'Five policy versions exist; review retention separately.'
jq . "$POLICY_FILE"
```

**Mutation — approved repair only:**

```bash
aws_bootstrap iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document "file://$POLICY_FILE" --set-as-default
```

**Verification:** repeat the default-version read and exact comparison above,
then restart inventory. Do not delete policy versions to make room automatically.

#### 7. Audit runtime boundaries before granting deployment access

**Read-only check and verification:** enumerate all existing roles with either
runtime prefix and retrieve each exact boundary. An unbounded or differently
bounded role means **stop for privileged migration/replacement**. The deploy
role intentionally cannot add, replace, or remove permissions boundaries.

```bash
aws_bootstrap iam get-policy --policy-arn "$BOUNDARY_ARN" >"$BOOTSTRAP_TMP/boundary.json"
aws_bootstrap iam list-roles >"$BOOTSTRAP_TMP/all-roles.json"
jq -r '.Roles[] | select((.RoleName | startswith("llteacher-production-execution-role-")) or (.RoleName | startswith("llteacher-production-task-role-"))) | .RoleName' "$BOOTSTRAP_TMP/all-roles.json" >"$BOOTSTRAP_TMP/runtime-role-names"
while IFS= read -r runtime_role; do
  aws_bootstrap iam get-role --role-name "$runtime_role" >"$BOOTSTRAP_TMP/runtime-role.json"
  jq -e --arg boundary "$BOUNDARY_ARN" '.Role.PermissionsBoundary.PermissionsBoundaryArn == $boundary' "$BOOTSTRAP_TMP/runtime-role.json" || stop 'Runtime role requires privileged migration/replacement.'
done <"$BOOTSTRAP_TMP/runtime-role-names"
```

#### 8. Deployment role trust and grants

**Read-only check:** trust must match the checked-in policy with subject
`repo:uw-ssec/llteacher:environment:production` and audience `sts.amazonaws.com`.
Unexpected existing trust is a stop condition. Compare before considering an
owner-reviewed update; never automatically broaden trust.

```bash
jq . infra/bootstrap/github-oidc-trust-policy.json
if test "$ROLE_EXISTS" = true; then
  aws_bootstrap iam get-role --role-name "$DEPLOY_ROLE" --query Role.AssumeRolePolicyDocument >"$BOOTSTRAP_TMP/live-trust.json"
  same_json infra/bootstrap/github-oidc-trust-policy.json "$BOOTSTRAP_TMP/live-trust.json" || stop 'Unexpected role trust; owner review required.'
fi
```

**Mutation — create only if absent:**

```bash
if test "$ROLE_EXISTS" = false; then
  aws_bootstrap iam create-role --role-name "$DEPLOY_ROLE" --assume-role-policy-document file://infra/bootstrap/github-oidc-trust-policy.json
fi
```

**Verification:**

```bash
aws_bootstrap iam get-role --role-name "$DEPLOY_ROLE" --query Role.AssumeRolePolicyDocument >"$BOOTSTRAP_TMP/live-trust.json"
same_json infra/bootstrap/github-oidc-trust-policy.json "$BOOTSTRAP_TMP/live-trust.json" || stop 'Trust verification failed.'
```

For an existing mismatched trust, the normal flow has stopped. After an owner
has reviewed the live/checked-in diff and explicitly approved that repair:

```bash
# Read-only check
aws_bootstrap iam get-role --role-name "$DEPLOY_ROLE" --query Role.AssumeRolePolicyDocument
jq . infra/bootstrap/github-oidc-trust-policy.json

# Mutation (approved repair only)
aws_bootstrap iam update-assume-role-policy --role-name "$DEPLOY_ROLE" --policy-document file://infra/bootstrap/github-oidc-trust-policy.json

# Verification
aws_bootstrap iam get-role --role-name "$DEPLOY_ROLE" --query Role.AssumeRolePolicyDocument >"$BOOTSTRAP_TMP/live-trust.json"
same_json infra/bootstrap/github-oidc-trust-policy.json "$BOOTSTRAP_TMP/live-trust.json" || stop 'Trust verification failed.'
```

**Read-only check:** no inline policies or unrelated managed policies may be
present. Review any existing deploy-role boundary as well; stop if unexpected.

```bash
aws_bootstrap iam get-role --role-name "$DEPLOY_ROLE" | jq -e '.Role.PermissionsBoundary == null'
aws_bootstrap iam list-role-policies --role-name "$DEPLOY_ROLE" | jq -e '.PolicyNames | length == 0'
aws_bootstrap iam list-attached-role-policies --role-name "$DEPLOY_ROLE" >"$BOOTSTRAP_TMP/attachments.json"
jq -e --arg prefix "arn:aws:iam::$ACCOUNT_ID:policy/llteacher-production-deploy-" 'all(.AttachedPolicies[]; .PolicyArn == ($prefix + "state") or .PolicyArn == ($prefix + "compute") or .PolicyArn == ($prefix + "data"))' "$BOOTSTRAP_TMP/attachments.json"
```

**Mutation — after the runtime-role audit succeeds:** attach the three reviewed
policies; repeating an existing attachment is harmless.

```bash
for policy_name in llteacher-production-deploy-state llteacher-production-deploy-compute llteacher-production-deploy-data; do
  aws_bootstrap iam attach-role-policy --role-name "$DEPLOY_ROLE" --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$policy_name"
done
```

**Verification:** check the complete attachment set and each current default
version against the reviewed JSON. Re-run step 7 before enabling releases.

```bash
aws_bootstrap iam list-attached-role-policies --role-name "$DEPLOY_ROLE" >"$BOOTSTRAP_TMP/attachments.json"
jq -e --arg prefix "arn:aws:iam::$ACCOUNT_ID:policy/llteacher-production-deploy-" '([.AttachedPolicies[].PolicyArn] | sort) == ([$prefix + "state", $prefix + "compute", $prefix + "data"] | sort)' "$BOOTSTRAP_TMP/attachments.json"
for index in 1 2 3; do
  POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/${POLICY_NAMES[$index]}"
  VERSION_ID=$(aws_bootstrap iam get-policy --policy-arn "$POLICY_ARN" --query Policy.DefaultVersionId --output text)
  aws_bootstrap iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$VERSION_ID" --query PolicyVersion.Document >"$BOOTSTRAP_TMP/live-policy.json"
  same_json "${POLICY_FILES[$index]}" "$BOOTSTRAP_TMP/live-policy.json" || stop 'Attached policy changed.'
done
```

#### 9. Protected GitHub environment

**Read-only check:** in `uw-ssec/llteacher`, inspect the `production` environment,
required reviewers, tag deployment rules, and existing variables. Stop for
unexpected settings. **Mutation:** configure the protected environment using
GitHub settings, with required reviewers and version-tag restrictions, and set:

| Environment variable | Exact value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::055237683908:role/llteacher-production-deploy` |
| `PULUMI_BACKEND_URL` | `s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra` |
| `PULUMI_STACK` | `production` |

**Verification:** reload settings and check all three values, required reviewers,
and tag restrictions. No Pulumi access token is used. Do not add AWS credentials
or application secrets to GitHub. This step does not authorize a release tag.

#### 10. Initialize the S3 stack with KMS secrets

Retain the old empty Cloud stack; do not transfer or delete it. Start fresh on
S3. Keep local Floci containers, volumes, keys, and encrypted state untouched.

**Read-only check:** repeat caller/account, alias, bucket, and backend checks
above. Install/build the infrastructure locally before Pulumi commands:

```bash
export AWS_PROFILE=default AWS_REGION=us-west-2
export PULUMI_BACKEND_URL=s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra
export PULUMI_STACK=production
test "$(aws sts get-caller-identity --profile default --region us-west-2 --query Account --output text)" = "$ACCOUNT_ID"
npm run build --workspace=infra
```

**Mutation — local backend selection, then read-only stack inventory:**

```bash
pulumi login "$PULUMI_BACKEND_URL"
test "$(pulumi whoami --verbose --json | jq -r '.url')" = "$PULUMI_BACKEND_URL" || stop 'Wrong Pulumi backend.'
pulumi -C infra stack ls --json >"$BOOTSTRAP_TMP/stacks.json"
jq . "$BOOTSTRAP_TMP/stacks.json"
```

**Mutation — only if `production` is absent:** inspect the inventory and stop
if it already exists; that is a resume/reconciliation task, not a fresh init.

```bash
jq -e 'all(.[]; .name != "production" and (.name | endswith("/production") | not))' "$BOOTSTRAP_TMP/stacks.json"
test ! -e infra/Pulumi.production.yaml || stop 'Existing production config: reconcile before init.'
pulumi -C infra stack init production --secrets-provider 'awskms://alias/llteacher-pulumi-state?region=us-west-2&awssdk=v2'
```

Keep `AWS_PROFILE=default` in the local operator environment only. The persisted
secrets-provider URL must omit a profile so GitHub Actions can use the temporary
OIDC environment credentials without requiring a shared credentials file.

**Verification:**

```bash
pulumi -C infra stack --stack production --show-urns
node --input-type=module -e 'import fs from "node:fs"; import yaml from "js-yaml"; const c=yaml.load(fs.readFileSync("infra/Pulumi.production.yaml","utf8")); if(c.secretsprovider !== "awskms://alias/llteacher-pulumi-state?region=us-west-2&awssdk=v2") process.exit(1);'
```

#### 11. Production configuration and secure secret entry

**Read-only check:** inspect masked configuration before setting anything:

```bash
pulumi -C infra config --stack production
```

**Mutation — non-secret initial configuration:**

```bash
pulumi -C infra config set aws:region us-west-2 --stack production
pulumi -C infra config set environment production --stack production
pulumi -C infra config set imageTag bootstrap --stack production
pulumi -C infra config set provisionService false --stack production
pulumi -C infra config set deployApp false --stack production
pulumi -C infra config set domainReady false --stack production
```

**Verification:**

```bash
test "$(pulumi -C infra config get aws:region --stack production)" = us-west-2
test "$(pulumi -C infra config get environment --stack production)" = production
test "$(pulumi -C infra config get provisionService --stack production)" = false
test "$(pulumi -C infra config get deployApp --stack production)" = false
pulumi -C infra config --stack production
```

Generate fresh production database and cryptographic secrets in an approved
password manager. Obtain production WorkOS and LLM credentials from approved
production sources. Never copy local development credentials automatically.
Do not enable shell tracing, display secret files, put values on the command
line, or use a terminal recorder during secret entry.

**Read-only check:** verify the masked config above has no unexpected existing
secret values before adding new ones. **Mutation — hidden interactive input:**

```bash
pulumi -C infra config set --secret databasePassword --stack production
pulumi -C infra config set --secret runtimeSecrets --stack production
```

At the second hidden prompt, paste the complete JSON object containing the
eight keys listed in “Secrets and normal configuration.” For multiline JSON,
use secure stdin from an owner-only file provided through your approved secret
workflow instead of the second prompt:

```bash
# Populate this owner-only path through the approved secret workflow first.
test -f "$BOOTSTRAP_TMP/runtime-secrets.json" || stop 'Secure secret file missing.'
chmod 600 "$BOOTSTRAP_TMP/runtime-secrets.json"
jq -e 'type == "object" and (["WORKOS_API_KEY","WORKOS_CLIENT_ID","WORKOS_WEBHOOK_SECRET","OPENROUTER_API_KEY","LLMOXIE_API_KEY","SESSION_SECRET","ENCRYPTION_KEY","BLIND_INDEX_KEY"] - keys | length == 0) and all(.[]; type == "string" and length > 0)' "$BOOTSTRAP_TMP/runtime-secrets.json" >/dev/null 2>&1 || stop 'Invalid runtime secret JSON or missing required keys.'
pulumi -C infra config set --secret runtimeSecrets --stack production <"$BOOTSTRAP_TMP/runtime-secrets.json"
```

**Verification:** masked config only; never run a secret-specific config read.

```bash
pulumi -C infra config --stack production
```

The [Pulumi config command](https://www.pulumi.com/docs/iac/cli/commands/pulumi_config_set/)
accepts omitted values through prompting or stdin. Remove the temporary plaintext
secret file using your approved secret-file cleanup procedure after encryption;
retain only non-secret bootstrap records. Do not commit plaintext secrets.

#### 12. Preview and stop

**Read-only verification:**

```bash
test "$(pulumi whoami --verbose --json | jq -r '.url')" = "$PULUMI_BACKEND_URL"
test "$(aws sts get-caller-identity --profile default --region us-west-2 --query Account --output text)" = 055237683908
pulumi -C infra preview --stack production --non-interactive
```

Stop after preview for cost/security review and explicit apply authorization.
Review resource counts, network exposure, exact IAM roles/boundaries, backups,
deletion protection, and recurring ALB/RDS/KMS/storage costs. Any unexpected
resource, account, region, backend, stack, replacement, or deletion stops the
process. Preview may use backend locks, but does not create application resources.
Do not use a release workflow as a substitute for the separate first-apply gate.

After separately authorized base infrastructure creation, configure `domainName`,
delegate the exported Route 53 nameservers, verify DNS and ACM, and separately
preview/review HTTPS activation with `domainReady=true`. Register the WorkOS
callback `https://<domain>/api/auth/callback`. The first application release needs
its own approval; domainless HTTP is allowed only while the app is inactive.

### Rollback and rotation

The workflow records the previous task-definition reference and image digest.
A code rollback can select the previous task definition after reviewing schema
compatibility; migrations are not automatically reversed. Never blindly roll
back across an incompatible migration. Keep the previous ECR image/task
definition available. A task replacement is required after secret rotation.

After confirming schema compatibility, copy the values from the workflow's
rollback summary and run:

```sh
export AWS_PROFILE=default AWS_REGION=us-west-2 STACK=production
export PULUMI_BACKEND_URL=s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra
test "$(aws sts get-caller-identity --profile default --region us-west-2 --query Account --output text)" = 055237683908 || exit 1
pulumi login "$PULUMI_BACKEND_URL"
export PREVIOUS_TASK=arn:aws:ecs:us-west-2:055237683908:task-definition/llteacher-production-app:6
pulumi -C infra config set --stack "$STACK" serviceTaskDefinition "$PREVIOUS_TASK"
pulumi -C infra config set --stack "$STACK" provisionService true
pulumi -C infra config set --stack "$STACK" deployApp true
pulumi -C infra preview --stack "$STACK" --non-interactive
pulumi -C infra up --stack "$STACK" --yes --non-interactive
```

Then wait for `llteacher-production-app` to stabilize and verify
`https://<domain>/api/health`. These commands roll back application code only;
they do not reverse database migrations or restore S3 versions.

## Verification boundaries and deferred work

Run `npm run typecheck`, `npm test`, `npm run build`, infra mock tests,
and local shell contract tests. Database-gated tests need disposable pgvector
PostgreSQL; OKF integration tests need the pinned 0.3.0 binary. Local smoke
checks supplement tests, not real-AWS validation.

SQS workers, multi-task availability, scaling, full disaster recovery, data
migration/Django retirement, and production cutover remain deferred. See the
[M12 audit](../docs/superpowers/plans/2026-09-21-m12-infrastructure-milestone-audit.md).
Existing dependency-audit findings also need triage before a public release.
Never mark all Milestone 12 issues complete merely because this stack boots.
