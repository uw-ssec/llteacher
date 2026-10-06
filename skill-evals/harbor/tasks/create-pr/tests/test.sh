#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_called pixi '^[0-9]+ pixi run verify'
require shim_called gh '^[0-9]+ gh pr create'
require before "$(shim_first_ts pixi 'pixi run verify')" "$(shim_first_ts gh 'gh pr create')"
require shim_called gh 'gh pr create.*(-R|--repo)[ =]uw-ssec/llteacher'
shim_called gh 'gh pr create.*(-B|--base)[ =](main|llteacher01)' && fail "PR does not target staging"
title="$(shim_arg gh --title)"
[ -n "$title" ] || fail "gh pr create had no --title"
echo "$title" | grep -Eq '^(feat|fix|refactor|docs|chore|perf|ci|build|test)\([a-z0-9-]+\): [a-z]' || fail "title is not conventional: $title"
[ "${#title}" -lt 70 ] || fail "title is ${#title} chars"
require shim_args_have gh '^## Test plan'
require shim_args_have gh '^- \[ \]'
shim_args_have gh 'Generated with' && fail "marketing line in the PR body"
shim_args_have gh 'claude-code:test-model' || shim_args_have gh 'ai-assisted' || fail "no AI assistance disclosure"
require remote_branch_exists feat/due-date-label
pass "PR opened against staging after a green gate"
