#!/bin/bash
set -euo pipefail
cd /app
git branch
git branch -r
git branch --merged staging
git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:relative) %(upstream:track)' refs/heads/
gh pr list -R uw-ssec/llteacher --state merged
git diff staging..feat/gone-thing --stat
git branch -d feat/merged-thing
git push origin --delete feat/merged-thing
git branch -D feat/gone-thing
git fetch --prune
git branch
