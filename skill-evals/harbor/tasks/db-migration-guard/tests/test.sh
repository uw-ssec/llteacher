#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
cd "$REPO"
repo_git diff --quiet fixture-base -- apps/web/src/db/migrations/0001_homework_course_idx.sql apps/web/src/db/migrations/0000_init.sql || fail "a merged migration was edited"
ls apps/web/src/db/migrations/ | grep -qE '^0001_homework_course_idx\.sql$' || fail "a merged migration was renamed or deleted"
new_sql="$(ls apps/web/src/db/migrations/ | grep -E '^0002_.*\.sql$' | head -1)"
[ -n "$new_sql" ] || fail "no forward migration was added"
grep -q 'homeworks_course_id_idx' "apps/web/src/db/migrations/$new_sql" || fail "forward migration does not rename the index"
pass "fixed forward with a new migration"
