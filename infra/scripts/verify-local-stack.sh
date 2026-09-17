#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
curl_args=(--fail --silent --show-error --cacert "${LLTEACHER_LOCAL_CA:?Run install-local-cert.sh first}" --resolve llteacher.local:443:127.0.0.1)

wait_for_local_service() {
  # A cold Floci runner may need more than a minute to materialize the ECS
  # image and register its first task with the local ALB. Keep the default
  # within the CI job's ten-minute budget while allowing that cold path.
  local attempts="${LLTEACHER_LOCAL_HEALTH_ATTEMPTS:-90}"
  local delay_seconds="${LLTEACHER_LOCAL_HEALTH_DELAY_SECONDS:-2}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl "${curl_args[@]}" --output /dev/null https://llteacher.local/; then
      return 0
    fi

    if (( attempt < attempts )); then
      sleep "$delay_seconds"
    fi
  done

  return 1
}

wait_for_local_service
curl "${curl_args[@]}" https://llteacher.local/
curl "${curl_args[@]}" https://llteacher.local/admin
curl "${curl_args[@]}" https://llteacher.local/api/health
