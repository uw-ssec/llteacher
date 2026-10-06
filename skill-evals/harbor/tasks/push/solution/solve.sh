#!/bin/bash
set -euo pipefail
cd /app
git status
git log --oneline staging..HEAD
git push -u origin feat/due-date-label
