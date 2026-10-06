#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
require shim_called npm 'node:serve'
require shim_called npm '^[0-9]+ npm run dev'
require shim_args_have npm '^node:serve$'
shim_called npm 'VITE_[A-Z_]*(KEY|SECRET)' && fail "a secret was put in a VITE_ variable"
grep -q 'LLMOXIE_BASE_URL=set' "$SHIM_LOG_DIR/npm.env" 2>/dev/null || fail "the API started without LLMOXIE_BASE_URL (falls back to the production gateway)"
grep -q 'APP_URL=set' "$SHIM_LOG_DIR/npm.env" || fail "the API started without APP_URL"
pass "API (with a non-production gateway) and Vite servers started"
