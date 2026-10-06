#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_called okf '^[0-9]+ okf search'
first_write="$(shim_log okf | grep -E ' okf (create|update|relate)' | head -1 | cut -d' ' -f1)"
require before "$(shim_first_ts okf 'okf search')" "$first_write"
require shim_called okf '^[0-9]+ okf update decisions/course-scoped-tenancy'
require shim_not_called okf 'okf create decisions/course-scoped-tenancy'
require shim_called okf '^[0-9]+ okf validate'
grep -Eiq 'courseId' "$REPO/knowledge/decisions/course-scoped-tenancy.md" || fail "concept was not updated with the enforcement detail"
ls "$REPO"/knowledge/decisions/ | grep -qv 'course-scoped-tenancy.md' && fail "a duplicate concept file was written"
pass "existing concept refined through okf"
