#!/bin/bash
set -euo pipefail
cd /app
cat > apps/web/src/db/schema/homeworks.ts <<'EOF'
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const homeworks = pgTable("homeworks", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  title: text("title").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
});
EOF
cd apps/web
npx drizzle-kit generate --name homework_due_at
cd /app
printf 'ALTER TABLE "homeworks" ADD COLUMN "due_at" timestamp with time zone;\n' >> apps/web/src/db/migrations/0002_homework_due_at.sql
npm run db:migrate
npm test --workspace=llteacher-web
