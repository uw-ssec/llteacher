#!/usr/bin/env bash
set -euo pipefail

if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$root/.floci/data" "$root/.pulumi/local"
docker start llteacher-floci >/dev/null 2>&1 || docker run -d --name llteacher-floci -p 4566:4566 -p 8443:443 \
  -e FLOCI_STORAGE_MODE=hybrid \
  -e FLOCI_SERVICES_RDS_DEFAULT_POSTGRES_IMAGE=pgvector/pgvector:pg16 \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$root/.floci/data:/app/data" floci/floci:latest >/dev/null
until curl -fsS http://localhost:4566/_localstack/health >/dev/null 2>&1 || curl -fsS http://localhost:4566 >/dev/null 2>&1; do sleep 1; done
echo "Floci is running at http://localhost:4566"
