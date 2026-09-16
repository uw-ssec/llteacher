#!/usr/bin/env bash
set -euo pipefail

if [[ "${PULUMI_STACK:-local}" != "local" ]]; then
  echo "Refusing non-local stack" >&2
  exit 2
fi

root=$(cd "$(dirname "$0")/../.." && pwd)
"$root/infra/scripts/local-up.sh"
LLTEACHER_LOCAL_CA="${LLTEACHER_LOCAL_CA:-$(mkcert -CAROOT)/rootCA.pem}" \
  "$root/infra/scripts/verify-local-stack.sh"
