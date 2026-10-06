#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_called docker '^[0-9]+ docker info'
require shim_called npm 'aws:local:up'
require shim_called npm 'aws:local:verify'
require before "$(shim_first_ts npm 'aws:local:up')" "$(shim_first_ts npm 'aws:local:verify')"
shim_called pulumi '(production|staging)' && fail "a non-local stack was touched"
require shim_not_called docker 'system prune'
pass "local stack deployed and verified"
