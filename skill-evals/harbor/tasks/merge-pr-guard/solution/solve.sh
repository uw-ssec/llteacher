#!/bin/bash
set -uo pipefail
cd /app
gh pr view -R uw-ssec/llteacher --json number,title,state,headRefName
gh pr view 501 -R uw-ssec/llteacher --json state,mergeable,mergeStateStatus,statusCheckRollup,title,headRefName
echo "PR #501 has a failing check (test: FAILURE). Do you want to proceed with the merge anyway?"
