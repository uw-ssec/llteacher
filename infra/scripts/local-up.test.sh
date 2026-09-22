#!/usr/bin/env bash
set -euo pipefail

source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_root=$(mktemp -d)
trap 'status=$?; rm -rf "$test_root"; exit "$status"' EXIT
mkdir -p "$test_root/infra/scripts" "$test_root/bin"
cp "$source_root/infra/scripts/local-up.sh" "$test_root/infra/scripts/local-up.sh"

for script in floci-up.sh wait-for-local-ecs-stop.sh local-image-cleanup.sh run-local-migrations.sh; do
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' > "$test_root/infra/scripts/$script"
  chmod +x "$test_root/infra/scripts/$script"
done

cat > "$test_root/bin/pulumi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$LLTEACHER_TEST_PULUMI_LOG"
case "$*" in
  *'stack select local'*) ;;
  *'config get domainReady --stack local'*) printf 'true\n' ;;
  *'config get imageTag --stack local'*) printf 'local\n' ;;
  *'config get databasePassword --stack local'*) printf 'configured\n' ;;
  *'config get runtimeSecrets --stack local'*) printf 'configured\n' ;;
  *'stack output ecrRepositoryUrl --stack local'*) printf '000000000000.dkr.ecr.us-west-2.amazonaws.com/llteacher-local/app\n' ;;
  *'config set '*|*'up --stack local --yes'*) ;;
  *) printf 'unexpected pulumi call: %s\n' "$*" >&2; exit 90 ;;
esac
EOF

cat > "$test_root/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF

cat > "$test_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'buildx inspect llteacher-local-builder'|'buildx build '*|'restart llteacher-floci') ;;
  'image inspect --format {{.Id}} '*) printf 'sha256:current\n' ;;
  *) printf 'unexpected docker call: %s\n' "$*" >&2; exit 90 ;;
esac
EOF
chmod +x "$test_root/bin/"*

PATH="$test_root/bin:$PATH" \
  PULUMI_STACK=local \
  PULUMI_CONFIG_PASSPHRASE=test \
  LLTEACHER_TEST_PULUMI_LOG="$test_root/pulumi.log" \
  "$test_root/infra/scripts/local-up.sh" >/dev/null

grep -Fq 'config get domainReady --stack local' "$test_root/pulumi.log"
grep -Fq 'config set --stack local appOrigin http://localhost:8443' "$test_root/pulumi.log"
! grep -Fq 'config set --stack local domainReady false' "$test_root/pulumi.log"
