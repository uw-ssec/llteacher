#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
"$root/infra/scripts/floci-up.sh"
export PULUMI_BACKEND_URL="file://$root/.pulumi/local"
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:?Set a local Pulumi passphrase first}"
if ! pulumi -C "$root/infra" stack select local >/dev/null 2>&1; then pulumi -C "$root/infra" stack init local --secrets-provider=passphrase; fi
if ! pulumi -C "$root/infra" config get databasePassword --stack local >/dev/null 2>&1; then
  echo "Set the local database password once: pulumi -C infra config set --stack local --secret databasePassword '<value>'" >&2
  exit 1
fi
npm run build --workspace=infra
pulumi -C "$root/infra" up --stack local --yes
repo=$(pulumi -C "$root/infra" stack output ecrRepositoryUrl --stack local)
docker build --tag "$repo:local" --file "$root/Dockerfile.aws" "$root"
# Floci's ECS service resolves an ECR-shaped image that already exists in the
# local Docker daemon. This avoids its registry proxy while preserving the
# production task-definition image URI; CI/production performs a real ECR push.
pulumi -C "$root/infra" config set --stack local provisionService true
pulumi -C "$root/infra" config set --stack local deployApp true
pulumi -C "$root/infra" up --stack local --yes
echo "Local ECS service deployed. Run npm run aws:local:verify after the ALB becomes healthy."
