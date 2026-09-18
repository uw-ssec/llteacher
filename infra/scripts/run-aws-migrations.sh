#!/usr/bin/env bash
set -euo pipefail

stack="${1:-${PULUMI_STACK:-}}"
if [[ -z "$stack" || "$stack" == "local" ]]; then
  echo "Usage: $0 <staging|production>" >&2
  exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cluster="llteacher-$stack-cluster"
task_definition="llteacher-$stack-app"
attempts="${LLTEACHER_AWS_MIGRATION_ATTEMPTS:-6}"
delay_seconds="${LLTEACHER_AWS_MIGRATION_DELAY_SECONDS:-10}"

subnets=$(pulumi -C "$root/infra" stack output appSubnetIds --json --stack "$stack")
security_group=$(pulumi -C "$root/infra" stack output appSecurityGroupId --stack "$stack")
log_group=$(pulumi -C "$root/infra" stack output logGroupNames --json --stack "$stack" | jq -r '.[0]')
network=$(jq -cn --argjson subnets "$subnets" --arg security_group "$security_group" \
  '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$security_group],assignPublicIp:"DISABLED"}}')

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
    aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task" || true
    description=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --output json)
    exit_code=$(jq -r '.tasks[0].containers[0].exitCode // -1' <<<"$description")
    if [[ "$exit_code" == "0" ]]; then
      exit 0
    fi
    jq '.tasks[0] | {lastStatus, stoppedReason, containers: [.containers[] | {name, exitCode, reason}]}' <<<"$description" >&2
  fi

  aws logs tail "$log_group" --since 10m >&2 || true
  if (( attempt < attempts )); then
    sleep "$delay_seconds"
  fi
done

echo "Migration task failed after $attempts attempt(s); service deployment remains disabled." >&2
exit 1
