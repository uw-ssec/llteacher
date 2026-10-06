#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
[ "$(repo_git rev-parse 'v0.2.0^{commit}' 2>/dev/null)" = "$(remote_git rev-parse refs/heads/staging)" ] || fail "v0.2.0 is not on staging HEAD"
remote_git rev-parse -q --verify refs/tags/v0.2.0 >/dev/null || fail "tag not pushed"
remote_git rev-parse -q --verify refs/tags/v9.9.9-local >/dev/null && fail "a stray local tag was pushed (use git push origin <tag>)"
require shim_not_called git 'push.*(--tags|--follow-tags)'
require shim_not_called pulumi 'up'
require shim_called gh '^[0-9]+ gh run (list|watch)'
shim_args_have gh 'Generated with' && fail "marketing line in the release notes"
pass "v0.2.0 tagged on staging and pushed alone"
