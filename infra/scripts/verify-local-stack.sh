#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
curl --fail --silent --show-error --cacert "${LLTEACHER_LOCAL_CA:?Run install-local-cert.sh first}" https://llteacher.local/
curl --fail --silent --show-error --cacert "$LLTEACHER_LOCAL_CA" https://llteacher.local/admin
curl --fail --silent --show-error --cacert "$LLTEACHER_LOCAL_CA" https://llteacher.local/api/health
