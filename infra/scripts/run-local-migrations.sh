#!/usr/bin/env bash
set -euo pipefail

if [[ "${PULUMI_STACK:-local}" != "local" ]]; then
  echo "Refusing non-local stack" >&2
  exit 2
fi

aws_local=(aws --endpoint-url=http://localhost:4566)
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

# A fresh Floci RDS resource is registered by Pulumi before its backing
# PostgreSQL container accepts connections. Wait for the emulator's RDS
# readiness signal so the migration gate is deterministic in disposable CI.
database_instance=$("${aws_local[@]}" rds describe-db-instances \
  --query 'DBInstances[0].DBInstanceIdentifier' --output text)
test "$database_instance" != "None"
"${aws_local[@]}" rds wait db-instance-available --db-instance-identifier "$database_instance"

network=$("${aws_local[@]}" ecs describe-services \
  --cluster llteacher-local-cluster \
  --services llteacher-local-app \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' \
  --output json)

attempts="${LLTEACHER_LOCAL_MIGRATION_ATTEMPTS:-6}"
delay_seconds="${LLTEACHER_LOCAL_MIGRATION_DELAY_SECONDS:-5}"

for ((attempt = 1; attempt <= attempts; attempt++)); do
  task=$("${aws_local[@]}" ecs run-task \
    --cluster llteacher-local-cluster \
    --task-definition llteacher-local-app \
    --launch-type FARGATE \
    --count 1 \
    --network-configuration "{\"awsvpcConfiguration\":$network}" \
    --overrides '{"containerOverrides":[{"name":"app","command":["npm","--workspace=apps/web","run","db:migrate"]}]}' \
    --query 'tasks[0].taskArn' --output text)

  "${aws_local[@]}" ecs wait tasks-stopped --cluster llteacher-local-cluster --tasks "$task"
  exit_code=$("${aws_local[@]}" ecs describe-tasks \
    --cluster llteacher-local-cluster --tasks "$task" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  if [[ "$exit_code" = 0 ]]; then
    exit 0
  fi

  "${aws_local[@]}" ecs describe-tasks \
    --cluster llteacher-local-cluster --tasks "$task" \
    --query 'tasks[0].{lastStatus:lastStatus,stoppedReason:stoppedReason,containers:containers[].{exitCode:exitCode,reason:reason}}' \
    --output json >&2

  # Floci's ECS API reports only the exit code. Its Docker-backed task log is
  # the authoritative diagnostic when a local migration fails.
  if [[ "${CI:-}" == "true" ]] && command -v docker >/dev/null; then
    docker ps -a --filter label=io.floci.service=ecs --format '{{.ID}}' | \
      xargs -r docker logs --tail 50 >&2 || true
  fi

  if (( attempt < attempts )); then
    sleep "$delay_seconds"
  fi
done

echo "Migration task failed after $attempts attempt(s); service deployment remains disabled." >&2
exit 1
