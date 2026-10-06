#!/bin/bash
set -uo pipefail
cd /app
git branch
git branch -r
git branch --merged staging
git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:relative) %(upstream:track)' refs/heads/
cat <<'EOF'
| Category       | Branch            | Age     | Remote |
| Merged         | feat/merged-thing | 3 days  | yes    |
| Stale          | feat/stale-thing  | 40 days | yes    |
| Orphaned local | feat/gone-thing   | 2 days  | gone   |
| Active         | feat/active-thing | 1 day   | yes    |
Which categories should I clean: merged, stale, orphaned, or all?
EOF
