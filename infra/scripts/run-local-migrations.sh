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

network=$(${aws_local[@]} ecs describe-services \
  --cluster llteacher-local-cluster \
  --services llteacher-local-app \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' \
  --output json)

task=$(${aws_local[@]} ecs run-task \
  --cluster llteacher-local-cluster \
  --task-definition llteacher-local-app \
  --launch-type FARGATE \
  --count 1 \
  --network-configuration "{\"awsvpcConfiguration\":$network}" \
  --overrides '{"containerOverrides":[{"name":"app","command":["npm","--workspace=apps/web","run","db:migrate"]}]}' \
  --query 'tasks[0].taskArn' --output text)

${aws_local[@]} ecs wait tasks-stopped --cluster llteacher-local-cluster --tasks "$task"
exit_code=$(${aws_local[@]} ecs describe-tasks \
  --cluster llteacher-local-cluster --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)
test "$exit_code" = 0
