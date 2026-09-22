#!/usr/bin/env bash
# Shared production contract. Callers use set -euo pipefail.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
die() { echo "$*" >&2; exit 1; }
readonly LLTEACHER_PRODUCTION_STACK=production
readonly LLTEACHER_PRODUCTION_BACKEND='s3://llteacher-pulumi-state-055237683908-us-west-2/llteacher-infra'
readonly LLTEACHER_PRODUCTION_ACCOUNT=055237683908

validate_release_target() {
  [[ "${1:-}" == "$LLTEACHER_PRODUCTION_STACK" ]] || die 'PULUMI_STACK must be production.'
  [[ "${PULUMI_BACKEND_URL:-}" == "$LLTEACHER_PRODUCTION_BACKEND" ]] || die "PULUMI_BACKEND_URL must be $LLTEACHER_PRODUCTION_BACKEND."
  [[ "${AWS_REGION:-}" == us-west-2 ]] || die 'AWS_REGION must be us-west-2.'
  # AWS CLI also consults AWS_DEFAULT_REGION; a stale local default must not win.
  export AWS_DEFAULT_REGION="$AWS_REGION"
}
validate_aws_account() {
  [[ "${1:-}" == "$LLTEACHER_PRODUCTION_ACCOUNT" ]] || die "AWS account must be $LLTEACHER_PRODUCTION_ACCOUNT."
}
validate_task_definition() {
  [[ "$1" =~ ^arn:aws:ecs:us-west-2:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]] || die 'Invalid production task-definition ARN.'
}
validate_deploy_role() {
  [[ "${1:-}" =~ ^arn:aws:iam::[0-9]{12}:role/.+ ]] || die 'AWS_DEPLOY_ROLE_ARN must be a valid IAM role ARN.'
}
validate_release_sha() {
  [[ "${1:-}" =~ ^[a-f0-9]{40}$ ]] || die 'GITHUB_SHA must be a 40-character lowercase hexadecimal commit SHA.'
}
validate_image_digest() {
  [[ "${1:-}" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'AWS did not return a valid sha256 image digest; refusing release.'
}
validate_log_group() {
  local value="${1:-}" pattern='^[A-Za-z0-9._/#-]+$'
  [[ -n "$value" && ${#value} -le 512 && "$value" =~ $pattern ]] || die 'Missing or invalid application log group.'
}
validate_refreshed_stack_config() {
  local region="${1:-}" environment="${2:-}" domain_ready="${3:-}" domain_name="${4:-}"
  [[ "$region" == us-west-2 ]] || die "Refreshed stack still uses aws:region ${region:-<unset>}. Inspect existing resources in that region and follow the documented region migration; do not overwrite the region blindly."
  [[ "$environment" == production ]] || die "Refreshed stack environment must be production, got ${environment:-<unset>}."
  [[ "$domain_ready" == true ]] || die 'Production release requires domainReady=true so activation cannot expose login or session traffic over HTTP.'
  [[ "$domain_name" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] || die 'Production release requires a valid domainName for HTTPS activation.'
}
validate_name() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,255}$ ]] && [[ "$1" != None && "$1" != null ]] || die 'Missing or invalid ECS name.'; }
validate_repository() {
  [[ "$1" =~ ^[0-9]{12}\.dkr\.ecr\.us-west-2\.amazonaws\.com/llteacher-production/app$ ]] || die 'Invalid production ECR repository URL.'
}
read_outputs() {
  outputs=$(pulumi -C "$root/infra" stack output --json --stack "$stack")
  jq -e 'type == "object" and all(.clusterName,.serviceName,.serviceTaskDefinition,.ecrRepositoryUrl,.logGroupName; . == null or type == "string")' <<<"$outputs" >/dev/null || die 'Invalid stack outputs.'
}
assert_no_service() {
  [[ -z "$(jq -r '.serviceName // empty' <<<"$outputs")" && -z "$(jq -r '.serviceTaskDefinition // empty' <<<"$outputs")" ]] || die 'Refusing bootstrap: stack already has a service.'
  local cluster services
  cluster=$(jq -r '.clusterName // empty' <<<"$outputs")
  if [[ -n "$cluster" ]]; then
    validate_name "$cluster"
    services=$(aws ecs list-services --cluster "$cluster" --output json)
    jq -e '.serviceArns | type == "array" and length == 0' <<<"$services" >/dev/null || die 'Refusing bootstrap: cluster has services or unreadable service state.'
  fi
}
