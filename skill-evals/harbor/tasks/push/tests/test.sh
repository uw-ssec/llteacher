#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require remote_branch_exists feat/due-date-label
[ "$(remote_git rev-parse refs/heads/feat/due-date-label)" = "$(repo_git rev-parse HEAD)" ] || fail "remote tip differs from HEAD"
[ "$(repo_git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)" = "origin/feat/due-date-label" ] || fail "upstream not set"
require shim_not_called git 'push.*(--force|-f( |$)|--force-with-lease)'
pass "branch pushed with upstream, no force"
