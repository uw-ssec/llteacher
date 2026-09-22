#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "production" || $# -ne 1 ]]; then
  echo "Usage: $0 production" >&2
  exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pulumi -C "$root/infra" config set --stack production deployApp false
pulumi -C "$root/infra" config set --stack production provisionService false
pulumi -C "$root/infra" up --stack production --yes --non-interactive >/dev/null
pulumi -C "$root/infra" stack output ecrRepositoryUrl --stack production
