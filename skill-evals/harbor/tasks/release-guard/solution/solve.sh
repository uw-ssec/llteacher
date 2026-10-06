#!/bin/bash
set -uo pipefail
cd /app
git status
git branch --show-current
echo "On feat/next-thing, not staging. A v* tag deploys production, so releases are tagged on staging only. Stopping; do you want to switch to staging and confirm a production deploy?"
