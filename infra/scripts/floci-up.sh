#!/usr/bin/env bash
set -euo pipefail

if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$root/.floci/data" "$root/.pulumi/local"
run_args=(-d --name llteacher-floci -p 4566:4566 -p 8443:443)
if [[ -n "${FLOCI_DOCKER_NETWORK:-}" ]]; then
  run_args+=(--network "$FLOCI_DOCKER_NETWORK" -e "FLOCI_SERVICES_DOCKER_NETWORK=$FLOCI_DOCKER_NETWORK")
fi
docker start llteacher-floci >/dev/null 2>&1 || docker run "${run_args[@]}" \
  -e FLOCI_STORAGE_MODE=hybrid \
  -e FLOCI_SERVICES_RDS_DEFAULT_POSTGRES_IMAGE=pgvector/pgvector:pg16 \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$root/.floci/data:/app/data" floci/floci:2.1.0 >/dev/null
attempts="${FLOCI_HEALTH_ATTEMPTS:-60}"
delay_seconds="${FLOCI_HEALTH_DELAY_SECONDS:-1}"
for ((attempt = 1; attempt <= attempts; attempt++)); do
  if curl -fsS http://localhost:4566/_localstack/health >/dev/null 2>&1 || curl -fsS http://localhost:4566 >/dev/null 2>&1; then
    echo "Floci is running at http://localhost:4566"
    exit 0
  fi
  if (( attempt < attempts )); then sleep "$delay_seconds"; fi
done
echo "Floci did not become healthy after $attempts attempt(s)." >&2
docker ps -a --filter name=llteacher-floci >&2 || true
docker logs --tail 100 llteacher-floci >&2 || true
exit 1
