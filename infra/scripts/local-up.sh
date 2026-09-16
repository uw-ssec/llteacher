#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
"$root/infra/scripts/floci-up.sh"
"$root/infra/scripts/tls-proxy-up.sh"
export PULUMI_BACKEND_URL="file://$root/.pulumi/local"
export PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:?Set a local Pulumi passphrase first}"
new_stack=false
if ! pulumi -C "$root/infra" stack select local >/dev/null 2>&1; then
  pulumi -C "$root/infra" stack init local --secrets-provider=passphrase
  new_stack=true
fi
pulumi -C "$root/infra" config set --stack local environment local
pulumi -C "$root/infra" config set --stack local domainName llteacher.local
pulumi -C "$root/infra" config set --stack local flociEndpoint http://localhost:4566
if ! pulumi -C "$root/infra" config get databasePassword --stack local >/dev/null 2>&1; then
  local_database_password=$(openssl rand -base64 24)
  pulumi -C "$root/infra" config set --stack local --secret databasePassword "$local_database_password"
  unset local_database_password
fi
npm run build --workspace=infra
if [[ "$new_stack" == true ]]; then
  # ECR must exist before the first local image can be built. This bootstrap
  # pass intentionally creates only the shared, persistent infrastructure.
  pulumi -C "$root/infra" config set --stack local provisionService false
  pulumi -C "$root/infra" config set --stack local deployApp false
  pulumi -C "$root/infra" up --stack local --yes
fi
repo=$(pulumi -C "$root/infra" stack output ecrRepositoryUrl --stack local)
image_tag="local-$(date +%s)"
image_uri="000000000000.dkr.ecr.us-east-1.amazonaws.com/${repo#*/}:$image_tag"
docker build --tag "$image_uri" --file "$root/Dockerfile.aws" "$root"
# Floci resolves this canonical ECR-shaped image directly from the local Docker
# daemon. Its CreateRepository URI is intentionally not used here: that is the
# registry proxy address, not the local-image lookup key.
pulumi -C "$root/infra" config set --stack local provisionService true
pulumi -C "$root/infra" config set --stack local deployApp true
pulumi -C "$root/infra" config set --stack local imageTag "$image_tag"
pulumi -C "$root/infra" up --stack local --yes
echo "Local ECS service deployed. Run npm run aws:local:verify after the ALB becomes healthy."
