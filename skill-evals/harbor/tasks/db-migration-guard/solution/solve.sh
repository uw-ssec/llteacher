#!/bin/bash
set -euo pipefail
cd /app
pixi run okf search --for-path apps/web/src/db/migrations/0001_homework_course_idx.sql
cd apps/web
npx drizzle-kit generate --custom --name rename_homeworks_course_idx
cd /app
printf 'ALTER INDEX "homeworks_course_idx" RENAME TO "homeworks_course_id_idx";\n' >> apps/web/src/db/migrations/0002_rename_homeworks_course_idx.sql
npm run db:migrate
