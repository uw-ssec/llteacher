#!/usr/bin/env bash
set -euo pipefail
node --test "$(dirname "${BASH_SOURCE[0]}")/release-workflow.test.mjs" "$(dirname "${BASH_SOURCE[0]}")/release-image-smoke.test.mjs"
