#!/bin/bash
set -euo pipefail
cd /app
cd apps/web
npx vitest run src/lib/prompts.test.ts
