#!/usr/bin/env bash
set -euo pipefail

source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'status=$?; rm -rf "$test_dir"; exit "$status"' EXIT
mkdir -p "$test_dir/infra/scripts"
cp "$source_root/infra/scripts/local-test.sh" "$test_dir/infra/scripts/local-test.sh"
cat > "$test_dir/infra/scripts/local-up.sh" <<'EOF'
#!/usr/bin/env bash
printf 'local-up\n' >> "$LLTEACHER_TEST_LOG"
EOF
cat > "$test_dir/infra/scripts/verify-local-stack.sh" <<'EOF'
#!/usr/bin/env bash
printf 'verify\n' >> "$LLTEACHER_TEST_LOG"
EOF
chmod +x "$test_dir/infra/scripts/"*.sh

LLTEACHER_TEST_LOG="$test_dir/log" "$test_dir/infra/scripts/local-test.sh"
grep -Fq 'local-up' "$test_dir/log"
grep -Fq 'verify' "$test_dir/log"
