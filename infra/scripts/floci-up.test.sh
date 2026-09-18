#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'status=$?; rm -rf "$test_dir"; exit "$status"' EXIT

cat > "$test_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LLTEACHER_TEST_DOCKER_LOG"
case "$1" in
  start) exit 1 ;;
  run) echo container-id ;;
  ps) echo 'llteacher-floci exited' ;;
  logs) echo 'floci diagnostic log' ;;
esac
EOF
cat > "$test_dir/curl" <<'EOF'
#!/usr/bin/env bash
exit 22
EOF
cat > "$test_dir/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$test_dir/docker" "$test_dir/curl" "$test_dir/sleep"

set +e
output=$(PATH="$test_dir:$PATH" PULUMI_STACK=local FLOCI_HEALTH_ATTEMPTS=2 FLOCI_HEALTH_DELAY_SECONDS=0 \
  LLTEACHER_TEST_DOCKER_LOG="$test_dir/docker.log" "$root/infra/scripts/floci-up.sh" 2>&1)
status=$?
set -e

test "$status" = 1
grep -Fq 'Floci did not become healthy after 2 attempt(s).' <<<"$output"
grep -Fq 'ps -a --filter name=llteacher-floci' "$test_dir/docker.log"
grep -Fq 'logs --tail 100 llteacher-floci' "$test_dir/docker.log"
