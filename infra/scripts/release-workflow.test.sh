#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
workflow="$root/.github/workflows/release.yml"

test ! -e "$root/.github/workflows/local-aws.yml"
for required in \
  'npm ci' 'npm run typecheck' 'npm test' 'npm run build' \
  'id-token: write' 'vars.AWS_DEPLOY_ROLE_ARN' 'secrets.PULUMI_ACCESS_TOKEN' \
  'us-west-2' 'docker/build-push-action' 'run-aws-migrations.sh' \
  'services-stable' '/api/health' 'BUILD_SHA' 'imageDigest' \
  'candidateTaskDefinitionArn' 'serviceTaskDefinition'; do
  grep -Fq "$required" "$workflow"
done

for forbidden in floci localhost:4566 aws:local 'secrets.AWS_DEPLOY_ROLE_ARN' WORKOS_API_KEY; do
  ! grep -Fqi "$forbidden" "$workflow"
done

line() { grep -nF "$1" "$workflow" | head -1 | cut -d: -f1; }
test "$(line 'npm run build')" -lt "$(line 'Build and push application image')"
test "$(line 'Build and push application image')" -lt "$(line 'Run candidate migrations')"
test "$(line 'Run candidate migrations')" -lt "$(line 'Activate migrated candidate')"
