#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
count="$(repo_git rev-list fixture-base..HEAD --count)"
[ "$count" = "0" ] || fail "a commit was created on a failing gate"
require shim_called pixi '^[0-9]+ pixi run verify'
require shim_not_called git 'no-verify'
pass "no commit on a failing gate"
