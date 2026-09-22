#!/usr/bin/env bash
set -euo pipefail
node --test --test-name-pattern='migration|helpers' "$(dirname "${BASH_SOURCE[0]}")/aws-release.test.mjs"
