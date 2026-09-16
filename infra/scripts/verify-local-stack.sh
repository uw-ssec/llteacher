#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
curl_args=(--fail --silent --show-error --cacert "${LLTEACHER_LOCAL_CA:?Run install-local-cert.sh first}" --resolve llteacher.local:443:127.0.0.1)
curl "${curl_args[@]}" https://llteacher.local/
curl "${curl_args[@]}" https://llteacher.local/admin
curl "${curl_args[@]}" https://llteacher.local/api/health
