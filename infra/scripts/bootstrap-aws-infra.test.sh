#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

cat > "$test_dir/pulumi" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LLTEACHER_TEST_CALLS"
case "$*" in
  *'stack output ecrRepositoryUrl'*) printf '%s\n' '123.dkr.ecr.us-west-2.amazonaws.com/llteacher-production/app' ;;
esac
EOF
chmod +x "$test_dir/pulumi"

set +e
PATH="$test_dir:$PATH" LLTEACHER_TEST_CALLS="$test_dir/calls" "$root/infra/scripts/bootstrap-aws-infra.sh" staging >/dev/null 2>&1
status=$?
set -e
test "$status" = 2

output=$(PATH="$test_dir:$PATH" LLTEACHER_TEST_CALLS="$test_dir/calls" "$root/infra/scripts/bootstrap-aws-infra.sh" production)
test "$output" = '123.dkr.ecr.us-west-2.amazonaws.com/llteacher-production/app'
grep -Fq 'config set --stack production deployApp false' "$test_dir/calls"
grep -Fq 'config set --stack production provisionService false' "$test_dir/calls"
grep -Fq 'up --stack production --yes --non-interactive' "$test_dir/calls"
! grep -Eqi 'secret|config --show-secrets' "$test_dir/calls"
