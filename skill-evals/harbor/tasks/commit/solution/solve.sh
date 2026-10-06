#!/bin/bash
set -euo pipefail
cd /app
git status
git diff --stat
git log --oneline -5
git add apps/web/src/server/routes/homeworks.ts apps/web/src/server/routes/homeworks.test.ts
pixi run verify
npm test --workspace=llteacher-web
git commit -q -m "$(cat <<'EOF'
fix(api): label homeworks that have no due date

Assisted-by: claude-code:test-model
EOF
)"
git status
