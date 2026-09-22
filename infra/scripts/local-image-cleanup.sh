#!/usr/bin/env bash
set -euo pipefail

current_image="${1:?Usage: $0 <current-image-id>}"
docker image ls --no-trunc --filter label=org.llteacher.local=true --format '{{.ID}}' | while read -r image; do
  [[ -z "$image" || "$image" == "$current_image" ]] && continue
  docker ps -a --filter "ancestor=$image" --format '{{.ID}}' | grep -q . && continue
  docker image rm "$image" || true
done
docker buildx prune --builder llteacher-local-builder --keep-storage 2GB --force >/dev/null
docker system df
docker image ls --filter label=org.llteacher.local=true
docker volume ls --filter label=io.floci.service=rds
