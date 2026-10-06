#!/bin/bash
set -euo pipefail
cd /app
git status
git diff --stat
git branch --show-current
git log --oneline staging..HEAD
git diff staging...HEAD --stat
pixi run verify
gh pr create -R uw-ssec/llteacher --base staging --title "feat(api): label homeworks without a due date" --body "$(cat <<'EOF'
## Summary
- Show "No due date" instead of an empty label on homeworks without a due date

## Changes
- api: add `dueLabel`
- tests: cover the missing due date

## Test plan
- [ ] `pixi run verify` exits 0
- [ ] `npm test --workspace=llteacher-web` passes

## AI assistance disclosure
claude-code:test-model
EOF
)"
