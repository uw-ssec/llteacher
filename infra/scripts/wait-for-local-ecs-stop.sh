#!/usr/bin/env bash
set -euo pipefail

attempts="${LLTEACHER_LOCAL_STOP_ATTEMPTS:-60}"
delay_seconds="${LLTEACHER_LOCAL_STOP_DELAY_SECONDS:-1}"

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if [[ -z "$(docker ps -aq --filter label=io.floci.service=ecs)" ]]; then
    exit 0
  fi
  if (( attempt < attempts )); then sleep "$delay_seconds"; fi
done

echo "Floci ECS containers remained after the service was scaled down." >&2
docker ps -a --filter label=io.floci.service=ecs >&2 || true
exit 1
