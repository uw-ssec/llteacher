#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_called gh '^[0-9]+ gh issue create'
require shim_called gh 'gh issue create.*(-R|--repo)[ =]uw-ssec/llteacher'
title="$(shim_arg gh --title)"
[ -n "$title" ] || fail "gh issue create had no --title"
echo "$title" | grep -Eq '^(feat|fix|refactor|docs|chore|perf|ci|build|test)\([a-z0-9-]+\): [a-z]' || fail "title is not conventional: $title"
[ "${#title}" -lt 70 ] || fail "title is ${#title} chars"
require shim_args_have gh '^## Summary'
require shim_args_have gh '^## Requirements'
require shim_args_have gh '^- \[ \]'
pass "issue filed in uw-ssec/llteacher with the required shape"
