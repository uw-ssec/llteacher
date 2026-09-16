#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
docker stop llteacher-floci >/dev/null 2>&1 || true
echo "Stopped persistent local Floci container; state remains in .floci/data."
