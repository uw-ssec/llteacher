#!/bin/bash
set -euo pipefail
cd /app
docker info
npm run aws:local:up
npm run aws:local:verify
