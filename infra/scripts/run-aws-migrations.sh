#!/usr/bin/env bash
set -euo pipefail

stack="${1:-${PULUMI_STACK:-}}"
task_definition="${2:-}"
if [[ "$stack" != "production" || -z "$task_definition" || $# -ne 2 ]]; then
  echo "Usage: $0 production <candidate-task-definition-arn>" >&2
  exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cluster=$(pulumi -C "$root/infra" stack output clusterName --stack "$stack")
attempts="${LLTEACHER_AWS_MIGRATION_ATTEMPTS:-6}"
delay_seconds="${LLTEACHER_AWS_MIGRATION_DELAY_SECONDS:-10}"
wait_seconds="${LLTEACHER_AWS_MIGRATION_WAIT_SECONDS:-600}"

subnets=$(pulumi -C "$root/infra" stack output appSubnetIds --json --stack "$stack")
security_group=$(pulumi -C "$root/infra" stack output appSecurityGroupId --stack "$stack")
network=$(jq -cn --argjson subnets "$subnets" --arg security_group "$security_group" \
  '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$security_group],assignPublicIp:"ENABLED"}}')

wait_for_stop() {
  if command -v timeout >/dev/null; then
    timeout "$wait_seconds" aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$1"
  else
    aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$1"
  fi
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  echo "Running database migration attempt $attempt/$attempts" >&2
  response=$(aws ecs run-task \
    --cluster "$cluster" \
    --task-definition "$task_definition" \
    --launch-type FARGATE \
    --count 1 \
    --network-configuration "$network" \
    --overrides '{"containerOverrides":[{"name":"app","command":["npm","--workspace=apps/web","run","db:migrate"]}]}' \
    --output json)
  task=$(jq -r '.tasks[0].taskArn // empty' <<<"$response")
  if [[ -z "$task" ]]; then
    jq '{failures}' <<<"$response" >&2
  else
    wait_for_stop "$task" || true
    description=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --output json)
    exit_code=$(jq -r '.tasks[0].containers[0].exitCode // -1' <<<"$description")
    if [[ "$exit_code" == "0" ]]; then
      exit 0
    fi
    jq '.tasks[0] | {lastStatus, stoppedReason, containers: [.containers[] | {name, exitCode, reason}]}' <<<"$description" >&2
  fi

  if (( attempt < attempts )); then
    sleep "$delay_seconds"
  fi
done

echo "Migration task failed after $attempts attempt(s); service deployment remains disabled." >&2
exit 1
