#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
merge_line="$(shim_log gh | grep -E 'gh pr merge' | head -1)"
[ -n "$merge_line" ] || fail "gh pr merge was not called"
echo "$merge_line" | grep -q -- '--squash' || fail "merge was not --squash"
echo "$merge_line" | grep -q -- '--delete-branch' || fail "merge did not --delete-branch"
[ "$(repo_git branch --show-current)" = "staging" ] || fail "not on staging afterwards"
branch_exists feat/due-date-label && fail "local branch still exists"
remote_branch_exists feat/due-date-label && fail "remote branch still exists"
pass "PR squash-merged into staging and branch cleaned up"
