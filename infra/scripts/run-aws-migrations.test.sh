#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'status=$?; rm -rf "$test_dir"; exit "$status"' EXIT
printf '0' > "$test_dir/count"

cat > "$test_dir/pulumi" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *"appSubnetIds"*) echo '["subnet-private-a","subnet-private-b"]' ;;
  *"appSecurityGroupId"*) echo sg-app ;;
  *"logGroupNames"*) echo '["/llteacher/app","/llteacher/job"]' ;;
  *) exit 90 ;;
esac
EOF

cat > "$test_dir/aws" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LLTEACHER_TEST_CALLS"
case "$*" in
  *"ecs run-task"*) echo '{"tasks":[{"taskArn":"task-test"}],"failures":[]}' ;;
  *"ecs wait tasks-stopped"*) ;;
  *"ecs describe-tasks"*)
    count=$(cat "$LLTEACHER_TEST_COUNT")
    count=$((count + 1))
    printf '%s' "$count" > "$LLTEACHER_TEST_COUNT"
    if [[ "$count" -eq 1 ]]; then
      echo '{"tasks":[{"lastStatus":"STOPPED","stoppedReason":"Essential container exited","containers":[{"name":"app","exitCode":1,"reason":"migration failed"}]}]}'
    else
      echo '{"tasks":[{"lastStatus":"STOPPED","containers":[{"name":"app","exitCode":0}]}]}'
    fi
    ;;
  *"logs tail"*) echo 'migration diagnostics' >&2 ;;
  *) exit 91 ;;
esac
EOF
chmod +x "$test_dir/pulumi" "$test_dir/aws"

calls="$test_dir/calls"
PATH="$test_dir:$PATH" \
  LLTEACHER_TEST_CALLS="$calls" \
  LLTEACHER_TEST_COUNT="$test_dir/count" \
  LLTEACHER_AWS_MIGRATION_ATTEMPTS=2 \
  LLTEACHER_AWS_MIGRATION_DELAY_SECONDS=0 \
  "$root/infra/scripts/run-aws-migrations.sh" staging

test "$(cat "$test_dir/count")" = 2
grep -Fq 'subnet-private-a' "$calls"
grep -Fq 'sg-app' "$calls"
grep -Fq 'logs tail /llteacher/app' "$calls"
! grep -Fq 'describe-services' "$calls"
