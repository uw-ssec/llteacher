#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
export PULUMI_BACKEND_URL="file://$root/.pulumi/local"
local_passphrase_file="$root/.floci/pulumi-passphrase"
if [[ -z "${PULUMI_CONFIG_PASSPHRASE:-}" && -f "$local_passphrase_file" ]]; then
  export PULUMI_CONFIG_PASSPHRASE="$(<"$local_passphrase_file")"
fi
curl_args=(--fail --silent --show-error)
local_app_port=8080
if [[ "$(pulumi -C "$root/infra" config get domainReady --stack local 2>/dev/null || true)" == "true" ]]; then
  local_app_port=8443
fi
local_app_url="http://127.0.0.1:$local_app_port"

wait_for_local_service() {
  # A cold Floci runner may need more than a minute to materialize the ECS
  # image and register its first task with the local ALB. Keep the default
  # within the CI job's ten-minute budget while allowing that cold path.
  local attempts="${LLTEACHER_LOCAL_HEALTH_ATTEMPTS:-90}"
  local delay_seconds="${LLTEACHER_LOCAL_HEALTH_DELAY_SECONDS:-2}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl "${curl_args[@]}" --output /dev/null "$local_app_url/"; then
      return 0
    fi

    if (( attempt < attempts )); then
      sleep "$delay_seconds"
    fi
  done

  return 1
}

if ! wait_for_local_service; then
  echo "Local app did not become healthy at $local_app_url after ${LLTEACHER_LOCAL_HEALTH_ATTEMPTS:-90} attempt(s)." >&2
  echo "Run npm run aws:local:up, then retry verification. Scoped container status follows (no environment or logs are displayed):" >&2
  docker ps -a --filter label=io.floci.service=ecs --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' >&2 || true
  docker ps -a --filter name=llteacher-floci --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' >&2 || true
  exit 1
fi
curl "${curl_args[@]}" "$local_app_url/"
curl "${curl_args[@]}" "$local_app_url/admin"
curl "${curl_args[@]}" "$local_app_url/api/health"
