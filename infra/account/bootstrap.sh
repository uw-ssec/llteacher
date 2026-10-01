#!/usr/bin/env bash
# Account-level prerequisites for the production Pulumi stack: state KMS key,
# state bucket, GitHub OIDC provider, service-linked roles, managed policies and
# the deploy role.
# Run rarely, by an account admin, with the `default` AWS profile.
#
#   infra/account/bootstrap.sh check   # read-only inventory, verification and policy JSON for review
#   infra/account/bootstrap.sh apply   # create what is absent, then verify
#
# Existing resources are never modified: any mismatch stops for owner review
# (see "Approved repairs" in infra/README.md). Safe to re-run.
# Backticks and ${KMS_KEY_ARN} in single quotes are literal on purpose.
# shellcheck disable=SC2016
set +x
set -euo pipefail
umask 077

mode=${1:-}
[[ $# -eq 1 && ($mode == check || $mode == apply) ]] || { echo "Usage: $0 check|apply" >&2; exit 2; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

export AWS_PROFILE=default AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true AWS_PAGER=''
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset AWS_ENDPOINT_URL AWS_ENDPOINT_URL_S3 AWS_ENDPOINT_URL_STS AWS_ENDPOINT_URL_KMS AWS_ENDPOINT_URL_IAM
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN

ACCOUNT_ID=055237683908
STATE_BUCKET=llteacher-pulumi-state-055237683908-us-west-2
KMS_ALIAS=alias/llteacher-pulumi-state
DEPLOY_ROLE=llteacher-production-deploy
OIDC_ARN=arn:aws:iam::055237683908:oidc-provider/token.actions.githubusercontent.com
BOUNDARY_ARN=arn:aws:iam::055237683908:policy/llteacher-production-runtime-boundary
POLICY_NAMES=(llteacher-production-runtime-boundary llteacher-production-deploy-state llteacher-production-deploy-compute llteacher-production-deploy-data llteacher-production-deploy-network)
GRANT_NAMES=(llteacher-production-deploy-state llteacher-production-deploy-compute llteacher-production-deploy-data llteacher-production-deploy-network)
# shellcheck disable=SC2054 # commas belong to each Key,Value tag argument
TAGS=(TagKey=Project,TagValue=llteacher TagKey=Environment,TagValue=production TagKey=ManagedBy,TagValue=bootstrap)

tmp=$(mktemp -d "${TMPDIR:-/tmp}/llteacher-bootstrap.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT

aws_bootstrap() { aws --profile default --region us-west-2 --output json "$@"; }
stop() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
# Only the named absence code means absent; denial/network errors stop.
read_optional() {
  local absence=$1 destination=$2
  shift 2
  if aws_bootstrap "$@" >"$destination" 2>"$tmp/read-error"; then
    return 0
  fi
  if grep -Fq "($absence)" "$tmp/read-error"; then
    return 1
  fi
  cat "$tmp/read-error" >&2
  stop 'Read failed; do not interpret this as absence.'
}
same_json() { diff -u <(jq -S . "$1") <(jq -S . "$2"); }
# In check mode, report the creation and skip it (returns 1).
will_create() {
  if [[ $mode == check ]]; then
    say "absent, apply would create: $1"
    return 1
  fi
  say "creating: $1"
}

identity() {
  test "$(aws configure get region --profile default)" = us-west-2 || stop 'Wrong configured region.'
  aws_bootstrap sts get-caller-identity >"$tmp/caller.json"
  jq -e --arg account "$ACCOUNT_ID" '.Account == $account' "$tmp/caller.json" >/dev/null || stop 'Wrong AWS account.'
  say "caller: $(jq -r .Arn "$tmp/caller.json")"
  local answer=
  if [[ $mode == apply ]]; then
    printf 'Apply account prerequisites as this principal? Review `check` output first. Type yes: '
    read -r answer || true
    [[ $answer == yes ]] || stop 'Not confirmed.'
  fi
}

inventory() {
  if read_optional NotFoundException "$tmp/key.json" kms describe-key --key-id "$KMS_ALIAS"; then KMS_EXISTS=true; else KMS_EXISTS=false; fi
  if read_optional 404 "$tmp/bucket.json" s3api head-bucket --bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID"; then BUCKET_EXISTS=true; else BUCKET_EXISTS=false; fi
  if read_optional NoSuchEntity "$tmp/oidc.json" iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN"; then OIDC_EXISTS=true; else OIDC_EXISTS=false; fi
  if read_optional NoSuchEntity "$tmp/role.json" iam get-role --role-name "$DEPLOY_ROLE"; then ROLE_EXISTS=true; else ROLE_EXISTS=false; fi
  say "exists: kms=$KMS_EXISTS bucket=$BUCKET_EXISTS oidc=$OIDC_EXISTS role=$ROLE_EXISTS"
  # A bucket without a known key means a partial bootstrap: never mint a replacement key for active state.
  if [[ $BUCKET_EXISTS == true && $KMS_EXISTS == false ]]; then
    stop 'Existing bucket without known key: reconcile first.'
  fi
}

kms_key() {
  KMS_KEY_ARN=
  if [[ $KMS_EXISTS == true ]]; then
    KMS_KEY_ARN=$(jq -er '.KeyMetadata.Arn' "$tmp/key.json")
  else
    will_create "KMS key and $KMS_ALIAS" || return 0
    aws_bootstrap kms list-aliases >"$tmp/aliases.json"
    jq -e --arg alias "$KMS_ALIAS" '[.Aliases[] | select(.AliasName == $alias)] | length == 0' "$tmp/aliases.json" >/dev/null || stop 'Alias exists with another target.'
    aws_bootstrap kms create-key --description 'LLTeacher production Pulumi state and secrets' \
      --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
      --policy "file://$here/pulumi-state-kms-key-policy.json" --tags "${TAGS[@]}" >"$tmp/created-key.json"
    KMS_KEY_ARN=$(jq -er '.KeyMetadata.Arn' "$tmp/created-key.json")
    say "record KMS key ARN: $KMS_KEY_ARN"
    aws_bootstrap kms create-alias --alias-name "$KMS_ALIAS" --target-key-id "$KMS_KEY_ARN"
    aws_bootstrap kms enable-key-rotation --key-id "$KMS_KEY_ARN"
  fi

  [[ $KMS_KEY_ARN == arn:aws:kms:us-west-2:$ACCOUNT_ID:key/* ]] || stop 'Wrong key ARN.'
  aws_bootstrap kms describe-key --key-id "$KMS_KEY_ARN" >"$tmp/key.json"
  jq -e --arg arn "$KMS_KEY_ARN" --arg account "$ACCOUNT_ID" '.KeyMetadata | .Arn == $arn and .AWSAccountId == $account and .KeyState == "Enabled" and .KeyManager == "CUSTOMER" and .KeyUsage == "ENCRYPT_DECRYPT" and .KeySpec == "SYMMETRIC_DEFAULT"' "$tmp/key.json" >/dev/null || stop 'Unexpected key metadata.'
  test "$(aws_bootstrap kms describe-key --key-id "$KMS_ALIAS" --query KeyMetadata.Arn --output text)" = "$KMS_KEY_ARN" || stop 'Mismatched key/alias.'
  aws_bootstrap kms get-key-rotation-status --key-id "$KMS_KEY_ARN" | jq -e '.KeyRotationEnabled == true' >/dev/null || stop 'Key rotation is not enabled.'
  aws_bootstrap kms get-key-policy --key-id "$KMS_KEY_ARN" --policy-name default --query Policy --output text >"$tmp/key-policy.json"
  same_json "$here/pulumi-state-kms-key-policy.json" "$tmp/key-policy.json" || stop 'Unexpected key policy.'
  say "verified: KMS key $KMS_KEY_ARN"
}

state_bucket() {
  local s3=(--bucket "$STATE_BUCKET" --expected-bucket-owner "$ACCOUNT_ID")
  jq -n --arg key "$KMS_KEY_ARN" '{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:"aws:kms",KMSMasterKeyID:$key},BucketKeyEnabled:false,BlockedEncryptionTypes:{EncryptionType:["SSE-C"]}}]}' >"$tmp/encryption.json"
  if [[ $BUCKET_EXISTS == false ]]; then
    will_create "state bucket $STATE_BUCKET" || return 0
    aws_bootstrap s3api create-bucket --bucket "$STATE_BUCKET" \
      --create-bucket-configuration LocationConstraint=us-west-2 --object-ownership BucketOwnerEnforced >/dev/null
    aws_bootstrap s3api put-bucket-ownership-controls "${s3[@]}" --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
    aws_bootstrap s3api put-public-access-block "${s3[@]}" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws_bootstrap s3api put-bucket-versioning "${s3[@]}" --versioning-configuration Status=Enabled
    aws_bootstrap s3api put-bucket-encryption "${s3[@]}" --server-side-encryption-configuration "file://$tmp/encryption.json"
    aws_bootstrap s3api put-bucket-policy "${s3[@]}" --policy "file://$here/pulumi-state-bucket-policy.json"
    aws_bootstrap s3api put-bucket-tagging "${s3[@]}" --tagging 'TagSet=[{Key=Project,Value=llteacher},{Key=Environment,Value=production},{Key=ManagedBy,Value=bootstrap}]'
  fi

  test "$(aws_bootstrap s3api get-bucket-location "${s3[@]}" --query LocationConstraint --output text)" = us-west-2 || stop 'Wrong bucket region.'
  aws_bootstrap s3api get-bucket-ownership-controls "${s3[@]}" | jq -e '.OwnershipControls.Rules == [{"ObjectOwnership":"BucketOwnerEnforced"}]' >/dev/null || stop 'Wrong object ownership.'
  aws_bootstrap s3api get-public-access-block "${s3[@]}" | jq -e '.PublicAccessBlockConfiguration == {"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}' >/dev/null || stop 'Missing public access block.'
  aws_bootstrap s3api get-bucket-versioning "${s3[@]}" | jq -e '.Status == "Enabled"' >/dev/null || stop 'Versioning is not enabled.'
  aws_bootstrap s3api get-bucket-encryption "${s3[@]}" | jq '.ServerSideEncryptionConfiguration' >"$tmp/live-encryption.json"
  same_json "$tmp/encryption.json" "$tmp/live-encryption.json" || stop 'Wrong bucket key/encryption.'
  aws_bootstrap s3api get-bucket-policy "${s3[@]}" --query Policy --output text >"$tmp/live-bucket-policy.json"
  same_json "$here/pulumi-state-bucket-policy.json" "$tmp/live-bucket-policy.json" || stop 'Unexpected bucket policy.'
  aws_bootstrap s3api get-bucket-tagging "${s3[@]}" | jq -e '(.TagSet | from_entries) as $tags | $tags.Project == "llteacher" and $tags.Environment == "production" and $tags.ManagedBy == "bootstrap"' >/dev/null || stop 'Missing bootstrap tags.'
  # Never expire state versions.
  if read_optional NoSuchLifecycleConfiguration "$tmp/lifecycle.json" s3api get-bucket-lifecycle-configuration "${s3[@]}"; then
    stop 'Unexpected lifecycle configuration.'
  fi
  say "verified: state bucket $STATE_BUCKET"
}

oidc_provider() {
  # Account-wide and possibly shared with other applications: reuse, never modify.
  if [[ $OIDC_EXISTS == false ]]; then
    will_create 'GitHub OIDC provider' || return 0
    aws_bootstrap iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com >/dev/null
  fi
  aws_bootstrap iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >"$tmp/oidc.json"
  jq -e '.Url == "token.actions.githubusercontent.com" and (.ClientIDList | index("sts.amazonaws.com") != null)' "$tmp/oidc.json" >/dev/null || stop 'Mismatched OIDC provider.'
  say 'verified: GitHub OIDC provider'
}

service_linked_roles() {
  local service role path index
  local services=(elasticloadbalancing.amazonaws.com rds.amazonaws.com)
  local roles=(AWSServiceRoleForElasticLoadBalancing AWSServiceRoleForRDS)

  for index in 0 1; do
    service=${services[$index]}
    role=${roles[$index]}
    path="/aws-service-role/$service/"
    if ! read_optional NoSuchEntity "$tmp/service-role-$index.json" iam get-role --role-name "$role"; then
      will_create "service-linked role $role for $service" || continue
      aws_bootstrap iam create-service-linked-role --aws-service-name "$service" >"$tmp/service-role-$index.json"
    fi
    jq -e --arg role "$role" --arg path "$path" \
      '.Role.RoleName == $role and .Role.Path == $path' "$tmp/service-role-$index.json" >/dev/null || \
      stop "Unexpected service-linked role $role."
    say "verified: service-linked role $role"
  done
}

# Compares a managed policy's default version with its reviewed file.
policy_matches() {
  local arn=$1 file=$2 version
  version=$(aws_bootstrap iam get-policy --policy-arn "$arn" --query Policy.DefaultVersionId --output text)
  aws_bootstrap iam get-policy-version --policy-arn "$arn" --version-id "$version" --query PolicyVersion.Document >"$tmp/live-policy.json"
  same_json "$file" "$tmp/live-policy.json"
}

# Only ${KMS_KEY_ARN} is substituted.
render_state_policy() {
  jq --arg key "$KMS_KEY_ARN" 'walk(if type == "string" and . == "${KMS_KEY_ARN}" then $key else . end)' \
    "$here/github-deploy-policy.template.json" >"$tmp/deploy-state.json"
  jq -e '[.. | strings | select(contains("${"))] | length == 0' "$tmp/deploy-state.json" >/dev/null || stop 'Unrendered policy template.'
}

# Prints every document apply would create or compare against, as rendered.
review_documents() {
  local doc
  say 'documents for review (non-secret):'
  for doc in pulumi-state-kms-key-policy.json pulumi-state-bucket-policy.json github-oidc-trust-policy.json runtime-permissions-boundary.json; do
    printf -- '--- %s\n' "$doc"
    jq . "$here/$doc"
  done
  if [[ -n $KMS_KEY_ARN ]]; then
    render_state_policy
    printf -- '--- github-deploy-policy.template.json (rendered with %s)\n' "$KMS_KEY_ARN"
    jq . "$tmp/deploy-state.json"
  else
    printf -- '--- github-deploy-policy.template.json (${KMS_KEY_ARN} is rendered after key creation)\n'
    jq . "$here/github-deploy-policy.template.json"
  fi
  for doc in github-compute-policy.json github-data-policy.json github-network-policy.json; do
    printf -- '--- %s\n' "$doc"
    jq . "$here/$doc"
  done
}

managed_policies() {
  if [[ -z $KMS_KEY_ARN ]]; then
    say 'absent, apply would create: all five managed policies (after the KMS key)'
    return 0
  fi
  render_state_policy
  POLICY_FILES=("$here/runtime-permissions-boundary.json" "$tmp/deploy-state.json" "$here/github-compute-policy.json" "$here/github-data-policy.json" "$here/github-network-policy.json")

  local index name file arn
  for index in 0 1 2 3 4; do
    name=${POLICY_NAMES[$index]} file=${POLICY_FILES[$index]}
    arn="arn:aws:iam::$ACCOUNT_ID:policy/$name"
    test "$(jq -c . "$file" | tr -d '\n' | wc -m | tr -d ' ')" -lt 6144 || stop "Oversized managed policy: $name"
    if read_optional NoSuchEntity "$tmp/policy.json" iam get-policy --policy-arn "$arn"; then
      policy_matches "$arn" "$file" || stop "Unexpected managed policy $name; see Approved repairs."
    else
      will_create "managed policy $name" || continue
      aws_bootstrap iam create-policy --policy-name "$name" --policy-document "file://$file" >/dev/null
      policy_matches "$arn" "$file" || stop "Policy verification failed: $name"
    fi
    say "verified: managed policy $name"
  done
}

# Deployment cannot add or change runtime role boundaries, so every existing
# runtime role must already carry the exact boundary.
audit_runtime_roles() {
  local runtime_role
  aws_bootstrap iam list-roles >"$tmp/all-roles.json"
  jq -r '.Roles[] | select((.RoleName | startswith("llteacher-production-execution-role-")) or (.RoleName | startswith("llteacher-production-task-role-"))) | .RoleName' "$tmp/all-roles.json" >"$tmp/runtime-role-names"
  while IFS= read -r runtime_role; do
    aws_bootstrap iam get-role --role-name "$runtime_role" >"$tmp/runtime-role.json"
    jq -e --arg boundary "$BOUNDARY_ARN" '.Role.PermissionsBoundary.PermissionsBoundaryArn == $boundary' "$tmp/runtime-role.json" >/dev/null || stop "Runtime role $runtime_role requires privileged migration/replacement."
  done <"$tmp/runtime-role-names"
  say 'verified: runtime roles carry the boundary'
}

# Deployment cannot claim untagged resources. Review that every existing
# LLTeacher production resource below shows LLTeacherStack=production.
ownership_inventory() {
  local owner='Tags[?Key==`LLTeacherStack`]|[0].Value'
  say 'ownership inventory (id, LLTeacherStack tag):'
  aws_bootstrap ec2 describe-vpcs --query "Vpcs[].[VpcId,$owner]" --output text
  aws_bootstrap ec2 describe-internet-gateways --query "InternetGateways[].[InternetGatewayId,$owner]" --output text
  aws_bootstrap ec2 describe-route-tables --query "RouteTables[].[RouteTableId,$owner]" --output text
  aws_bootstrap ec2 describe-subnets --query "Subnets[].[SubnetId,$owner]" --output text
  aws_bootstrap ec2 describe-security-groups --query "SecurityGroups[].[GroupId,$owner]" --output text
  aws_bootstrap acm list-certificates --includes keyTypes=RSA_1024,RSA_2048,RSA_3072,RSA_4096,EC_prime256v1,EC_secp384r1,EC_secp521r1 --query 'CertificateSummaryList[].[CertificateArn,DomainName]' --output text
}

deploy_role() {
  local trust="$here/github-oidc-trust-policy.json" prefix="arn:aws:iam::$ACCOUNT_ID:policy/llteacher-production-deploy-" name index
  [[ -n $KMS_KEY_ARN || $ROLE_EXISTS == false ]] || stop 'Existing deploy role without known key: reconcile first.'
  if [[ $ROLE_EXISTS == true ]]; then
    jq '.Role.AssumeRolePolicyDocument' "$tmp/role.json" >"$tmp/live-trust.json"
    same_json "$trust" "$tmp/live-trust.json" || stop 'Unexpected role trust; see Approved repairs.'
  else
    will_create "deploy role $DEPLOY_ROLE" || return 0
    aws_bootstrap iam create-role --role-name "$DEPLOY_ROLE" --assume-role-policy-document "file://$trust" >/dev/null
  fi

  aws_bootstrap iam get-role --role-name "$DEPLOY_ROLE" >"$tmp/role.json"
  jq '.Role.AssumeRolePolicyDocument' "$tmp/role.json" >"$tmp/live-trust.json"
  same_json "$trust" "$tmp/live-trust.json" || stop 'Trust verification failed.'
  jq -e '.Role.PermissionsBoundary == null' "$tmp/role.json" >/dev/null || stop 'Unexpected deploy-role boundary.'
  aws_bootstrap iam list-role-policies --role-name "$DEPLOY_ROLE" | jq -e '.PolicyNames | length == 0' >/dev/null || stop 'Unexpected inline deploy-role policy.'
  aws_bootstrap iam list-attached-role-policies --role-name "$DEPLOY_ROLE" >"$tmp/attachments.json"
  jq -e --arg prefix "$prefix" 'all(.AttachedPolicies[]; .PolicyArn == ($prefix + "state") or .PolicyArn == ($prefix + "compute") or .PolicyArn == ($prefix + "data") or .PolicyArn == ($prefix + "network"))' "$tmp/attachments.json" >/dev/null || stop 'Unexpected deploy-role attachment.'

  if [[ $mode == apply ]]; then
    for name in "${GRANT_NAMES[@]}"; do
      aws_bootstrap iam attach-role-policy --role-name "$DEPLOY_ROLE" --policy-arn "arn:aws:iam::$ACCOUNT_ID:policy/$name"
    done
    aws_bootstrap iam list-attached-role-policies --role-name "$DEPLOY_ROLE" >"$tmp/attachments.json"
  fi
  jq -e --arg prefix "$prefix" '([.AttachedPolicies[].PolicyArn] | sort) == ([$prefix + "state", $prefix + "compute", $prefix + "data", $prefix + "network"] | sort)' "$tmp/attachments.json" >/dev/null || {
    [[ $mode == check ]] && { say 'apply would attach the four deployment grants'; return 0; }
    stop 'Attachment verification failed.'
  }
  for index in 1 2 3 4; do
    policy_matches "arn:aws:iam::$ACCOUNT_ID:policy/${POLICY_NAMES[$index]}" "${POLICY_FILES[$index]}" || stop 'Attached policy changed.'
  done
  say "verified: deploy role $DEPLOY_ROLE with four grants"
}

identity
inventory
kms_key
if [[ $mode == check ]]; then review_documents; fi
state_bucket
oidc_provider
service_linked_roles
managed_policies
audit_runtime_roles
ownership_inventory
deploy_role

cat <<EOF

Account prerequisites ($mode) complete. GitHub \`production\` environment variables:
  AWS_DEPLOY_ROLE_ARN = arn:aws:iam::$ACCOUNT_ID:role/$DEPLOY_ROLE
  PULUMI_BACKEND_URL  = s3://$STATE_BUCKET/llteacher-infra
  PULUMI_STACK        = production
EOF
