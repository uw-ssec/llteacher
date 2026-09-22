#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'status=$?; rm -rf "$test_dir"; exit "$status"' EXIT

counter="$test_dir/curl-count"
printf '0' > "$counter"

cat > "$test_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count=$(cat "$LLTEACHER_TEST_CURL_COUNTER")
count=$((count + 1))
printf '%s' "$count" > "$LLTEACHER_TEST_CURL_COUNTER"
if [[ "$count" -eq 1 ]]; then
  exit 22
fi
printf 'ok\n'
EOF
chmod +x "$test_dir/curl"

set +e
PATH="$test_dir:$PATH" \
  PULUMI_STACK=local \
  LLTEACHER_LOCAL_HEALTH_ATTEMPTS=2 \
  LLTEACHER_LOCAL_HEALTH_DELAY_SECONDS=0 \
  LLTEACHER_TEST_CURL_COUNTER="$counter" \
  "$root/infra/scripts/verify-local-stack.sh" >/dev/null
verify_status=$?
set -e

test "$verify_status" = "0"

# One transient failure, one successful readiness probe, then three HTTP endpoint checks.
test "$(cat "$counter")" = "5"
