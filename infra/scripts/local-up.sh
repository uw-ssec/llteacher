#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
"$root/infra/scripts/floci-up.sh"
export PULUMI_BACKEND_URL="file://$root/.pulumi/local"
# Keep the local backend decryptable across normal up/down cycles without
# requiring a developer to remember a manually chosen passphrase. This file is
# mode 0600 and ignored by Git; an explicitly supplied environment variable
# still takes precedence for CI or recovery use.
local_passphrase_file="$root/.floci/pulumi-passphrase"
if [[ -z "${PULUMI_CONFIG_PASSPHRASE:-}" ]]; then
  if [[ ! -f "$local_passphrase_file" ]]; then
    umask 077
    openssl rand -base64 48 > "$local_passphrase_file"
  fi
  export PULUMI_CONFIG_PASSPHRASE="$(<"$local_passphrase_file")"
fi
if ! pulumi -C "$root/infra" stack select local >/dev/null 2>&1; then
  pulumi -C "$root/infra" stack init local --secrets-provider=passphrase
fi
pulumi -C "$root/infra" config set --stack local environment local
pulumi -C "$root/infra" config set --stack local domainName llteacher.local
pulumi -C "$root/infra" config set --stack local flociEndpoint http://localhost:4566
pulumi -C "$root/infra" config set --stack local aws:region us-west-2
pulumi -C "$root/infra" config set --stack local flociTaskEndpoint http://host.docker.internal:4566
pulumi -C "$root/infra" config set --stack local appOrigin http://localhost:8080
if ! pulumi -C "$root/infra" config get imageTag --stack local >/dev/null 2>&1; then
  pulumi -C "$root/infra" config set --stack local imageTag local-bootstrap
fi
if ! pulumi -C "$root/infra" config get databasePassword --stack local >/dev/null 2>&1; then
  local_database_password=$(openssl rand -base64 24)
  pulumi -C "$root/infra" config set --stack local --secret databasePassword "$local_database_password"
  unset local_database_password
fi
if ! pulumi -C "$root/infra" config get runtimeSecrets --stack local >/dev/null 2>&1; then
  local_runtime_secrets=$(jq -cn \
    --arg WORKOS_API_KEY "$(openssl rand -base64 32)" \
    --arg WORKOS_CLIENT_ID "$(openssl rand -base64 32)" \
    --arg OPENROUTER_API_KEY "$(openssl rand -base64 32)" \
    --arg LLMOXIE_API_KEY "$(openssl rand -base64 32)" \
    --arg SESSION_SECRET "$(openssl rand -base64 32)" \
    --arg ENCRYPTION_KEY "$(openssl rand -base64 32)" \
    --arg BLIND_INDEX_KEY "$(openssl rand -base64 32)" \
    --arg WORKOS_WEBHOOK_SECRET "$(openssl rand -base64 32)" \
    '$ARGS.named')
  pulumi -C "$root/infra" config set --stack local --secret runtimeSecrets "$local_runtime_secrets"
  unset local_runtime_secrets
fi
npm run build --workspace=infra
if ! repo=$(pulumi -C "$root/infra" stack output ecrRepositoryUrl --stack local 2>/dev/null); then
  # ECR must exist before the first local image can be built. This bootstrap
  # pass intentionally creates only the shared, persistent infrastructure.
  pulumi -C "$root/infra" config set --stack local provisionService false
  pulumi -C "$root/infra" config set --stack local deployApp false
  pulumi -C "$root/infra" up --stack local --yes
  repo=$(pulumi -C "$root/infra" stack output ecrRepositoryUrl --stack local)
fi
image_tag="local"
image_uri="000000000000.dkr.ecr.us-west-2.amazonaws.com/llteacher-local/app:$image_tag"
docker buildx inspect llteacher-local-builder >/dev/null 2>&1 || docker buildx create --name llteacher-local-builder --driver docker-container --use
docker buildx build --builder llteacher-local-builder --load --label org.llteacher.local=true --tag "$image_uri" --file "$root/Dockerfile.aws" "$root"
image_id=$(docker image inspect --format '{{.Id}}' "$image_uri")
# Floci resolves this canonical ECR-shaped image directly from the local Docker
# daemon. Its CreateRepository URI is intentionally not used here: that is the
# registry proxy address, not the local-image lookup key.
pulumi -C "$root/infra" config set --stack local provisionService true
pulumi -C "$root/infra" config set --stack local imageTag "$image_tag"
pulumi -C "$root/infra" config set --stack local buildSha "$(docker image inspect --format '{{.Id}}' "$image_uri")"
pulumi -C "$root/infra" config set --stack local deployApp false
pulumi -C "$root/infra" up --stack local --yes
# Floci resolves local tags when it creates Docker-backed tasks. Remove any
# superseded labelled image after the service is stopped so migration and app
# tasks cannot reuse a stale image behind the stable local tag.
"$root/infra/scripts/wait-for-local-ecs-stop.sh"
"$root/infra/scripts/local-image-cleanup.sh" "$image_id" images-only
"$root/infra/scripts/run-local-migrations.sh"
pulumi -C "$root/infra" config set --stack local deployApp true
pulumi -C "$root/infra" up --stack local --yes
"$root/infra/scripts/local-image-cleanup.sh" "$image_id"
echo "Local ECS service deployed. Run npm run aws:local:verify after the ALB becomes healthy."
