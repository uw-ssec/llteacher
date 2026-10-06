#!/bin/bash
set -euo pipefail
cd /app
git fetch origin --tags
git checkout staging
git pull origin staging
git status
git tag --sort=-v:refname | head -1
git log --oneline v0.1.9..origin/staging
gh run list -R uw-ssec/llteacher --branch staging --limit 5
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
gh run list -R uw-ssec/llteacher --workflow release.yml --limit 1
gh run watch -R uw-ssec/llteacher 9001
gh release create v0.2.0 -R uw-ssec/llteacher --title "v0.2.0" --generate-notes
echo "Released v0.2.0"
