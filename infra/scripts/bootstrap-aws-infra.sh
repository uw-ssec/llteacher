#!/usr/bin/env bash
set -euo pipefail

stack="${1:-}"
if [[ "${stack##*/}" != "production" || $# -ne 1 ]]; then
  echo "Usage: $0 [organization/project/]production" >&2
  exit 2
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pulumi -C "$root/infra" config set --stack "$stack" deployApp false
pulumi -C "$root/infra" config set --stack "$stack" provisionService false
pulumi -C "$root/infra" up --stack "$stack" --yes --non-interactive >/dev/null
pulumi -C "$root/infra" stack output ecrRepositoryUrl --stack "$stack"
