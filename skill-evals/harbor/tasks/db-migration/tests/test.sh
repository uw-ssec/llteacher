#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
cd "$REPO"
grep -q 'due_at' apps/web/src/db/schema/homeworks.ts || fail "schema not changed"
new_sql="$(ls apps/web/src/db/migrations/ | grep -E '^0002_.*\.sql$' | head -1)"
[ -n "$new_sql" ] || fail "no 0002 migration was generated"
grep -q "\"tag\": \"${new_sql%.sql}\"" apps/web/src/db/migrations/meta/_journal.json || fail "journal has no entry for $new_sql"
require shim_called npx 'drizzle-kit generate'
repo_git diff --quiet fixture-base -- apps/web/src/db/migrations/0000_init.sql apps/web/src/db/migrations/0001_homework_course_idx.sql || fail "an applied migration was edited"
require shim_not_called npx 'drizzle-kit (push|migrate)'
require shim_called npm 'db:migrate'
pass "migration generated, journal updated, applied migrations untouched"
