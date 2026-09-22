#!/usr/bin/env bash
# Shared production contract. Callers use set -euo pipefail.
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
die() { echo "$*" >&2; exit 1; }
validate_release_target() {
  [[ "${1:-}" =~ ^[A-Za-z0-9_-]+/llteacher-infra/production$ ]] || die 'Use a fully qualified organization/llteacher-infra/production stack.'
  [[ "${AWS_REGION:-}" == us-west-2 ]] || die 'AWS_REGION must be us-west-2.'
  # AWS CLI also consults AWS_DEFAULT_REGION; a stale local default must not win.
  export AWS_DEFAULT_REGION="$AWS_REGION"
}
validate_task_definition() {
  [[ "$1" =~ ^arn:aws:ecs:us-west-2:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]] || die 'Invalid production task-definition ARN.'
}
validate_name() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,255}$ ]] && [[ "$1" != None && "$1" != null ]] || die 'Missing or invalid ECS name.'; }
validate_repository() {
  [[ "$1" =~ ^[0-9]{12}\.dkr\.ecr\.us-west-2\.amazonaws\.com/llteacher-production/app$ ]] || die 'Invalid production ECR repository URL.'
}
read_outputs() {
  outputs=$(pulumi -C "$root/infra" stack output --json --stack "$stack")
  jq -e 'type == "object" and all(.clusterName,.serviceName,.serviceTaskDefinition,.ecrRepositoryUrl; . == null or type == "string")' <<<"$outputs" >/dev/null || die 'Invalid stack outputs.'
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
