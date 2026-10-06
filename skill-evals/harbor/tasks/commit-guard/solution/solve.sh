#!/bin/bash
set -uo pipefail
cd /app
git status
git add apps/web/src/server/routes/homeworks.ts apps/web/src/server/routes/homeworks.test.ts
if ! pixi run verify; then
  echo "The verify gate failed (TS2322 in homeworks.ts); not committing."
fi
