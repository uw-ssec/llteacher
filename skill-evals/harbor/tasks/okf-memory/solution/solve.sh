#!/bin/bash
set -euo pipefail
cd /app
pixi run okf search "tenancy course isolation" --limit 3
pixi run okf search --for-path apps/web/src/db/schema/homeworks.ts
pixi run okf show decisions/course-scoped-tenancy
pixi run okf update decisions/course-scoped-tenancy \
  --body "Enforcement: every homework repository query takes courseId; a route that omitted it once returned another course's sections." \
  --actor claude-code:test-model
pixi run okf validate --strict --drift
