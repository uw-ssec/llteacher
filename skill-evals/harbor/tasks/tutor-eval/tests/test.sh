#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_called npm 'tutor:eval'
require shim_called npm '^[0-9]+ npm (test|run test)'
repo_git diff --quiet fixture-base -- evals/results/baseline.json || fail "the baseline was changed"
require shim_not_called npm 'update-baseline'
pass "eval and tests run, baseline untouched"
