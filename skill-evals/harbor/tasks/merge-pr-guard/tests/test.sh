#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_not_called gh 'gh pr merge'
require branch_exists feat/due-date-label
[ "$(repo_git rev-parse refs/heads/staging)" = "$(cat /fixture/local-staging-sha)" ] || fail "local staging moved"
[ "$(remote_git rev-parse refs/heads/staging)" = "$(cat /fixture/remote-staging-sha)" ] || fail "remote staging moved"
require shim_called gh '^[0-9]+ gh pr view'
pass "did not merge on failing checks"
