#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
# Stage 1: the setup gate, with each toolchain doing its own job.
require shim_called pixi '^[0-9]+ pixi install'
require shim_called npm '^[0-9]+ npm (ci|install)( |$)'
require shim_called pixi '^[0-9]+ pixi run verify'
require before "$(shim_first_ts pixi 'pixi install')" "$(shim_first_ts pixi 'pixi run verify')"
require before "$(shim_first_ts npm 'npm (ci|install)')" "$(shim_first_ts pixi 'pixi run verify')"
for tool in pip pip3 conda; do
  [ -s "$SHIM_LOG_DIR/$tool.log" ] && fail "$tool was invoked"
done
shim_called npm 'install -g' && fail "a global npm install was used"

# Stage 2/3: orientation came from project memory, after the gate.
require shim_called okf '^[0-9]+ okf show project/(llteacher|current-state)'
require shim_called okf '^[0-9]+ okf show architecture/'
require before "$(shim_first_ts pixi 'pixi run verify')" "$(shim_first_ts okf 'okf show')"

# Stage 4: the API/data newcomer was pointed at the tenancy rule.
shim_called okf 'okf (show|search).*(tenant|tenancy|scope)' || fail "tenancy must-know was not covered for an API/data newcomer"

# Onboarding changes nothing in the repository.
[ -z "$(repo_git status --porcelain -- . ':!node_modules' ':!.pixi')" ] || fail "onboarding modified the repository"
pass "setup gated first, then oriented from project memory"
