#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/docker" <<'EOF'
#!/usr/bin/env bash
count_file="$TEST_COUNT_FILE"
count=0
[[ -f "$count_file" ]] && count=$(<"$count_file")
count=$((count + 1))
printf '%s' "$count" > "$count_file"
if (( count < 3 )); then printf 'old-task\n'; fi
EOF
chmod +x "$tmp/docker"

PATH="$tmp:$PATH" TEST_COUNT_FILE="$tmp/count" LLTEACHER_LOCAL_STOP_ATTEMPTS=3 \
  LLTEACHER_LOCAL_STOP_DELAY_SECONDS=0 "$root/infra/scripts/wait-for-local-ecs-stop.sh"
test "$(<"$tmp/count")" = 3
