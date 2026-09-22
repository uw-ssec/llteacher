#!/usr/bin/env bash
set -euo pipefail

current_image="${1:?Usage: $0 <current-image-id>}"
mode="${2:-full}"
if [[ "$mode" != "full" && "$mode" != "images-only" ]]; then
  echo "Usage: $0 <current-image-id> [images-only]" >&2
  exit 2
fi
docker image ls --no-trunc --filter label=org.llteacher.local=true --format '{{.ID}}' | while read -r image; do
  [[ -z "$image" || "$image" == "$current_image" ]] && continue
  docker ps -a --filter "ancestor=$image" --format '{{.ID}}' | grep -q . && continue
  docker image rm "$image" || true
done
if [[ "$mode" == "full" ]]; then
  docker buildx prune --builder llteacher-local-builder --keep-storage 2GB --force >/dev/null
fi
docker system df
docker image ls --filter label=org.llteacher.local=true
docker volume ls --filter label=io.floci.service=rds
