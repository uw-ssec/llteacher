#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
log="$test_dir/aws.log"

printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\\n" "$*" >> "$AWS_LOG"' \
  'case "$*" in' \
  '  *"ecs describe-services"*) echo "{\"subnets\":[\"subnet-1\"],\"securityGroups\":[\"sg-1\"],\"assignPublicIp\":\"ENABLED\"}" ;;' \
  '  *"ecs run-task"*) echo "task-1" ;;' \
  '  *"ecs wait tasks-stopped"*) ;;' \
  '  *"ecs describe-tasks"*) echo "1" ;;' \
  '  *) exit 90 ;;' \
  'esac' > "$test_dir/aws"
chmod +x "$test_dir/aws"

set +e
PATH="$test_dir:$PATH" AWS_LOG="$log" PULUMI_STACK=local "$root/infra/scripts/run-local-migrations.sh"
exit_code=$?
set -e

test "$exit_code" -ne 0
! grep -q 'ecs update-service' "$log"
grep -Fq '"command":["npm","--workspace=apps/web","run","db:migrate"]' "$log"
echo "migration failure prevented service update"
