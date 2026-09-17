#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)

# Linux Docker engines do not create host.docker.internal automatically.
grep -Fq -- '--add-host=host.docker.internal:host-gateway' "$root/infra/scripts/tls-proxy-up.sh"
