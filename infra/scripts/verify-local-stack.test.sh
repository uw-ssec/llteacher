#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'status=$?; rm -rf "$test_dir"; exit "$status"' EXIT

counter="$test_dir/curl-count"
printf '0' > "$counter"
curl_log="$test_dir/curl.log"

cat > "$test_dir/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LLTEACHER_TEST_CURL_LOG"
count=$(cat "$LLTEACHER_TEST_CURL_COUNTER")
count=$((count + 1))
printf '%s' "$count" > "$LLTEACHER_TEST_CURL_COUNTER"
if [[ "$count" -eq 1 ]]; then
  exit 22
fi
if [[ "${LLTEACHER_TEST_FAIL_ALWAYS:-false}" == "true" ]]; then
  exit 22
fi
printf 'ok\n'
EOF
chmod +x "$test_dir/curl"

cat > "$test_dir/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LLTEACHER_TEST_DOCKER_LOG"
EOF
chmod +x "$test_dir/docker"

cat > "$test_dir/pulumi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"config get domainReady --stack local"* ]]; then
  printf '%s\n' "$LLTEACHER_TEST_DOMAIN_READY"
  exit 0
fi
exit 90
EOF
chmod +x "$test_dir/pulumi"

set +e
PATH="$test_dir:$PATH" \
  PULUMI_STACK=local \
  LLTEACHER_LOCAL_HEALTH_ATTEMPTS=2 \
  LLTEACHER_LOCAL_HEALTH_DELAY_SECONDS=0 \
  LLTEACHER_TEST_CURL_COUNTER="$counter" \
  LLTEACHER_TEST_CURL_LOG="$curl_log" \
  LLTEACHER_TEST_DOMAIN_READY=true \
  "$root/infra/scripts/verify-local-stack.sh" >/dev/null
verify_status=$?
set -e

test "$verify_status" = "0"

# One transient failure, one successful readiness probe, then three HTTP endpoint checks.
test "$(cat "$counter")" = "5"
test "$(grep -Fc 'http://127.0.0.1:8443' "$curl_log")" = "5"
! grep -Fq 'http://127.0.0.1:8080' "$curl_log"

printf '0' > "$counter"
docker_log="$test_dir/docker.log"
set +e
failure_output=$(PATH="$test_dir:$PATH" \
  PULUMI_STACK=local \
  LLTEACHER_LOCAL_HEALTH_ATTEMPTS=2 \
  LLTEACHER_LOCAL_HEALTH_DELAY_SECONDS=0 \
  LLTEACHER_TEST_CURL_COUNTER="$counter" \
  LLTEACHER_TEST_CURL_LOG="$curl_log" \
  LLTEACHER_TEST_DOCKER_LOG="$docker_log" \
  LLTEACHER_TEST_DOMAIN_READY=false \
  LLTEACHER_TEST_FAIL_ALWAYS=true \
  "$root/infra/scripts/verify-local-stack.sh" 2>&1)
failure_status=$?
set -e
test "$failure_status" = "1"
grep -Fq 'Local app did not become healthy' <<<"$failure_output"
grep -Fq 'Run npm run aws:local:up' <<<"$failure_output"
grep -Fq 'ps -a --filter label=io.floci.service=ecs' "$docker_log"
grep -Fq 'ps -a --filter name=llteacher-floci' "$docker_log"
! grep -Eq 'logs|inspect|env' "$docker_log"
