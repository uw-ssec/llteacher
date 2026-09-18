#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'status=$?; rm -rf "$test_dir"; exit "$status"' EXIT
counter="$test_dir/count"
printf '0' > "$counter"

cat > "$test_dir/aws" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"ecs describe-services"*) echo '{"subnets":["subnet-1"],"securityGroups":["sg-1"],"assignPublicIp":"ENABLED"}' ;;
  *"rds describe-db-instances"*) echo test-db ;;
  *"rds wait db-instance-available"*|*"ecs wait tasks-stopped"*) ;;
  *"ecs run-task"*) echo task-test ;;
  *"ecs describe-tasks"*) count=$(cat "$LLTEACHER_TEST_COUNTER"); count=$((count + 1)); printf '%s' "$count" > "$LLTEACHER_TEST_COUNTER"; [[ "$count" -eq 1 ]] && echo 1 || echo 0 ;;
  *) exit 90 ;;
esac
EOF
chmod +x "$test_dir/aws"

PATH="$test_dir:$PATH" PULUMI_STACK=local LLTEACHER_LOCAL_MIGRATION_ATTEMPTS=2 LLTEACHER_LOCAL_MIGRATION_DELAY_SECONDS=0 LLTEACHER_TEST_COUNTER="$counter" "$root/infra/scripts/run-local-migrations.sh"
test "$(cat "$counter")" = 3
