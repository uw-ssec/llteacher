#!/bin/bash
set -euo pipefail
cd /app
git status
git add apps/web/src/server/routes/grades.ts apps/web/src/server/routes/grades.test.ts
pixi run verify > /tmp/verify.log 2>&1; echo "exit=$?"; tail -20 /tmp/verify.log
npm test --workspace=llteacher-web
