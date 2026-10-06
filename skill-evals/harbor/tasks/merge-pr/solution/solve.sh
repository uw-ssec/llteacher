#!/bin/bash
set -euo pipefail
cd /app
gh pr view -R uw-ssec/llteacher --json number,title,state,headRefName
gh pr view 501 -R uw-ssec/llteacher --json state,mergeable,mergeStateStatus,statusCheckRollup,title,headRefName
git status
gh pr merge 501 -R uw-ssec/llteacher --squash --delete-branch
git checkout staging
git pull origin staging
git fetch --prune
git branch -d feat/due-date-label || git branch -D feat/due-date-label
echo "PR #501 merged into staging. Branch feat/due-date-label deleted locally and remotely."
