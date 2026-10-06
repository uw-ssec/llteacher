#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_called pixi '^[0-9]+ pixi run verify'
require shim_called npm '^[0-9]+ npm (test|run test)'
repo_git ls-files --error-unmatch apps/web/src/server/routes/grades.ts >/dev/null 2>&1 || fail "the new file was not staged before the gate"
require before "$(shim_first_ts git 'git add')" "$(shim_first_ts pixi 'pixi run verify')"
[ "$(repo_git rev-list fixture-base..HEAD --count)" = "0" ] || fail "verify should not commit"
pass "staged, gated, and tested"
