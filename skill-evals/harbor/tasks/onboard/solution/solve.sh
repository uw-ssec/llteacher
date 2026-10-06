#!/bin/bash
set -euo pipefail
cd /app
git --version
pixi --version
node --version || true
pixi install
npm ci
pixi run pre-commit-install
pixi run verify > /tmp/verify.log 2>&1; echo "exit=$?"; tail -15 /tmp/verify.log
pixi run okf show project/llteacher
pixi run okf show project/current-state
pixi run okf show architecture/system-overview
pixi run okf show requirements/tenant-scoped-data-access
pixi run okf search "tenancy data access" --limit 3
