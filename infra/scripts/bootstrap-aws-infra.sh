#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/aws-release-common.sh"
stack="${1:-}"
[[ $# -eq 1 ]] || die "Usage: $0 production"
validate_release_target "$stack"
read_outputs
assert_no_service
pulumi -C "$root/infra" config set --stack "$stack" deployApp false
pulumi -C "$root/infra" config set --stack "$stack" provisionService false
pulumi -C "$root/infra" up --stack "$stack" --yes --non-interactive >/dev/null
read_outputs
repository=$(jq -er '.ecrRepositoryUrl' <<<"$outputs")
validate_repository "$repository"
printf '%s\n' "$repository"
