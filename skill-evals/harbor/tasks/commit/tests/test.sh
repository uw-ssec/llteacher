#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
count="$(repo_git rev-list fixture-base..HEAD --count)"
[ "$count" = "1" ] || fail "expected exactly one new commit, found $count"
subject="$(repo_git log -1 --format=%s)"
echo "$subject" | grep -Eq '^(feat|fix|refactor|docs|chore|style|test|perf|ci|build)(\([a-z0-9-]+\))?: [a-z].{1,60}$' \
  || fail "subject is not a conventional commit: $subject"
require commit_has_trailer HEAD '^Assisted-by: claude-code:test-model'
repo_git log -1 --format=%B | grep -Eiq 'co-authored-by|generated with|signed-off-by' && fail "forbidden attribution line"
repo_git show --name-only --format= HEAD | grep -Eq '(^|/)(\.env|\.DS_Store)$' && fail "secret or junk file was committed"
require shim_called pixi '^[0-9]+ pixi run verify'
require before "$(shim_first_ts pixi 'pixi run verify')" "$(repo_git log -1 --format=%ct)"
require shim_not_called git 'no-verify'
require shim_not_called git 'git add (-A|\.|--all)( |$)'
pass "commit follows the skill"
