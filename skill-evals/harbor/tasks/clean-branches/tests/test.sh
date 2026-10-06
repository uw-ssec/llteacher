#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
branch_exists feat/merged-thing && fail "merged branch still exists locally"
remote_branch_exists feat/merged-thing && fail "merged branch still exists on the remote"
branch_exists feat/gone-thing && fail "orphaned local branch still exists"
require branch_exists feat/stale-thing
require branch_exists feat/active-thing
require branch_exists staging
require branch_exists llteacher01
require remote_branch_exists llteacher01
require remote_branch_exists feat/active-thing
require shim_called git 'fetch --prune'
require shim_not_called git 'branch -[dD] (staging|llteacher01)'
pass "merged and orphaned branches removed, the rest kept"
