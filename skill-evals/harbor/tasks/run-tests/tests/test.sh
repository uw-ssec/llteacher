#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
shim_called npx '^[0-9]+ npx vitest run( [^ ]+)* src/lib/prompts\.test\.ts' \
  || shim_called npm '^[0-9]+ npm (test|run test)( [^ ]+)* .*prompts\.test\.ts' \
  || fail "the one test file was not re-run through npx vitest / npm test"
repo_git diff fixture-base -- apps/web/src | grep -Eq '^\+.*(\.skip|\.todo|skipIf)' && fail "a test was silenced"
require shim_not_called pip 'install'
pass "single test file re-run"
