#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/aws-release-common.sh"
stack="${1:-}"
task_definition="${2:-}"
[[ $# -eq 2 ]] || die "Usage: $0 production <candidate-task-definition-arn>"
validate_release_target "$stack"
validate_task_definition "$task_definition"
read_outputs
cluster=$(jq -er '.clusterName' <<<"$outputs")
validate_name "$cluster"
log_group=$(jq -er '.logGroupName' <<<"$outputs")
validate_log_group "$log_group"
attempts="${LLTEACHER_AWS_MIGRATION_ATTEMPTS:-6}"
delay_seconds="${LLTEACHER_AWS_MIGRATION_DELAY_SECONDS:-10}"
wait_seconds="${LLTEACHER_AWS_MIGRATION_WAIT_SECONDS:-600}"

[[ "$attempts" =~ ^[1-9][0-9]*$ && "$attempts" -le 6 ]] || die 'Migration attempts must be between 1 and 6.'
[[ "$delay_seconds" =~ ^[0-9]+$ && "$delay_seconds" -le 60 ]] || die 'Migration delay must be between 0 and 60 seconds.'
[[ "$wait_seconds" =~ ^[1-9][0-9]*$ && "$wait_seconds" -le 600 ]] || die 'Migration wait must be between 1 and 600 seconds.'
subnets=$(jq -ce '.appSubnetIds | select(type == "array" and length > 0 and length <= 16) | select(all(.[]; type == "string" and test("^subnet-[a-f0-9]+$")))' <<<"$outputs")
security_group=$(jq -er '.appSecurityGroupId | select(type == "string" and test("^sg-[a-f0-9]+$"))' <<<"$outputs")
network=$(jq -cn --argjson subnets "$subnets" --arg security_group "$security_group" \
  '{awsvpcConfiguration:{subnets:$subnets,securityGroups:[$security_group],assignPublicIp:"ENABLED"}}')

wait_for_stop() {
  if command -v timeout >/dev/null; then
    timeout "$wait_seconds" aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$1"
  else
    aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$1"
  fi
}

report_terminal_failure() {
  local task="$1" description="$2" stopped_reason container_reason task_id expected_log_stream
  stopped_reason=$(jq -r '.tasks[0].stoppedReason // "not reported"' <<<"$description")
  container_reason=$(jq -r '[.tasks[0].containers[] | select(.name == "app")] | .[0].reason // "not reported"' <<<"$description")
  task_id="${task##*/}"
  expected_log_stream="app/app/$task_id"
  echo "Migration task $task stopped without success." >&2
  echo "Stopped reason: $stopped_reason" >&2
  echo "App container reason: $container_reason" >&2
  echo "CloudWatch Logs: group '$log_group', expected stream '$expected_log_stream' (it may not exist when the container failed before startup)." >&2
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
    [[ "$task" =~ ^arn:aws:ecs:us-west-2:[0-9]{12}:task/([A-Za-z0-9_-]+/)?[a-f0-9]{32}$ ]] || die 'Invalid ECS task ARN; refusing retry.'
    # A timed-out waiter does not prove the migration stopped. Abort this release;
    # an operator must resolve the task before another release is attempted.
    wait_for_stop "$task" || die "Migration waiter failed for $task; refusing overlapping retry."
    description=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --output json)
    jq -e 'select((.failures | length) == 0) | .tasks | length == 1 and .[0].lastStatus == "STOPPED"' <<<"$description" >/dev/null || die "Migration task $task is not confirmed STOPPED; refusing overlapping retry."
    jq -e '[.tasks[0].containers[] | select(.name == "app")] | length == 1' <<<"$description" >/dev/null || die "Migration task $task has no unique app container; refusing retry."
    exit_code=$(jq -r '[.tasks[0].containers[] | select(.name == "app")][0].exitCode // empty' <<<"$description")
    if [[ "$exit_code" == "0" ]]; then
      exit 0
    fi
    report_terminal_failure "$task" "$description"
  fi

  if (( attempt < attempts )); then
    sleep "$delay_seconds"
  fi
done

echo "Migration task failed after $attempts attempt(s); candidate was not activated." >&2
exit 1
