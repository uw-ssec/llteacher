#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# The setup script creates this repository-local certificate. The test runner
# must use it rather than rediscovering a machine-specific mkcert CA location.
grep -Fq 'LLTEACHER_LOCAL_CA="${LLTEACHER_LOCAL_CA:-$root/.floci/certs/llteacher.local.pem}"' \
  "$root/infra/scripts/local-test.sh"
! grep -Fq 'mkcert -CAROOT' "$root/infra/scripts/local-test.sh"
