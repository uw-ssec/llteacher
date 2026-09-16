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
echo "Infrastructure is ready at zero app tasks. Build/push the ECR image, then set deployApp=true and run this command again."
