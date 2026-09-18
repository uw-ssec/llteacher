#!/usr/bin/env bash
set -euo pipefail

if [[ "${PULUMI_STACK:-local}" != "local" ]]; then
  echo "Refusing non-local stack" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
"$root/infra/scripts/local-up.sh"
# install-local-cert.sh creates this deterministic repository-local trust
# anchor before the clean-room deployment exercise begins.
LLTEACHER_LOCAL_CA="${LLTEACHER_LOCAL_CA:-$root/.floci/certs/llteacher.local.pem}" \
  "$root/infra/scripts/verify-local-stack.sh"
