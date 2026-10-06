#!/bin/bash
set -uo pipefail
cd /app
docker info || echo "Docker is not running. Start Docker Desktop (open -a Docker) and rerun npm run aws:local:up. I won't deploy to production: that only happens through the tag-triggered release workflow with approval."
