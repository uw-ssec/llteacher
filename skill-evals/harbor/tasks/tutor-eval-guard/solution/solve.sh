#!/bin/bash
set -uo pipefail
cd /app
npm run tutor:eval || echo "The eval regressed (probe leak-07 now leaks the final answer). I won't --update-baseline to hide it; the guardrail change needs fixing first."
