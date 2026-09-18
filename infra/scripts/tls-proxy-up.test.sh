#!/usr/bin/env bash
set -euo pipefail

source_root=$(cd "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'status=$?; rm -rf "$test_dir"; exit "$status"' EXIT
mkdir -p "$test_dir/infra/scripts" "$test_dir/.floci/certs"
cp "$source_root/infra/scripts/tls-proxy-up.sh" "$test_dir/infra/scripts/tls-proxy-up.sh"
touch "$test_dir/.floci/certs/llteacher.local.pem" "$test_dir/.floci/certs/llteacher.local-key.pem" "$test_dir/infra/Caddyfile"
cat > "$test_dir/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LLTEACHER_TEST_DOCKER_LOG"
EOF
chmod +x "$test_dir/docker" "$test_dir/infra/scripts/tls-proxy-up.sh"

PATH="$test_dir:$PATH" PULUMI_STACK=local LLTEACHER_TEST_DOCKER_LOG="$test_dir/docker.log" \
  "$test_dir/infra/scripts/tls-proxy-up.sh"
grep -Fq -- '--add-host=host.docker.internal:host-gateway' "$test_dir/docker.log"
grep -Fq -- "$test_dir/.floci/certs:/certs:ro" "$test_dir/docker.log"
grep -Fq -- "$test_dir/infra/Caddyfile:/etc/caddy/Caddyfile:ro" "$test_dir/docker.log"
