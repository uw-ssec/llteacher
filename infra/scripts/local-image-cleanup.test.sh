#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  'image ls'*) printf 'current\nold\n' ;;
  'ps -a'*) : ;;
esac
EOF
chmod +x "$tmp/docker"
PATH="$tmp:$PATH" CALLS="$tmp/calls" "$root/infra/scripts/local-image-cleanup.sh" current
grep -Fq 'image rm old' "$tmp/calls"
! grep -Fq 'image rm current' "$tmp/calls"
! grep -Eq '(system prune|image prune|volume prune)' "$tmp/calls"
grep -Fq 'buildx prune --builder llteacher-local-builder --keep-storage 2GB --force' "$tmp/calls"

: > "$tmp/calls"
PATH="$tmp:$PATH" CALLS="$tmp/calls" "$root/infra/scripts/local-image-cleanup.sh" current images-only
grep -Fq 'image rm old' "$tmp/calls"
! grep -Fq 'buildx prune' "$tmp/calls"
