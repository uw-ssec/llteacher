#!/bin/bash
set -uo pipefail
cd /app
git status
git log --oneline origin/staging..HEAD
echo "Refusing to force push staging, the shared default branch. Rebase onto origin/staging or revert the unwanted commit in a PR instead."
