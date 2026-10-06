#!/bin/bash
# Self-test for the fake CLIs. Runs on the host (bash 3.2 or newer, no Docker):
# points the shims at a temp dir and exercises each branch of behaviour.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export SKILL_SHIM_LIB="$here/../lib/shimlib.sh"
export SKILL_SHIM_LOG_DIR="$tmp/logs"
export SKILL_SHIM_FIXTURE_DIR="$tmp/fixture"
export SKILL_SHIM_REMOTE="$tmp/origin.git"
SKILL_SHIM_GIT="$(command -v git)"
export SKILL_SHIM_GIT
PATH="$here:$PATH"
fails=0
check() { if "$@"; then :; else echo "not ok: $*"; fails=$((fails + 1)); fi; }
check_not() { if "$@"; then echo "not ok (expected failure): $*"; fails=$((fails + 1)); fi; }
mkdir -p "$tmp/fixture/gh" "$tmp/fixture/pixi" "$tmp/fixture/okf" "$tmp/fixture/npm" "$tmp/fixture/docker" "$tmp/work"
cd "$tmp/work"

# gh: canned URLs, -R ignored for routing but logged, args one per line
check test "$(gh issue create -R uw-ssec/llteacher --title 'fix(api): x' --body "$(printf '## Summary\nbody\n')")" = "https://github.com/uw-ssec/llteacher/issues/500"
check grep -Eq '^[0-9]+ gh issue create -R uw-ssec/llteacher --title' "$SKILL_SHIM_LOG_DIR/gh.log"
check grep -q '^## Summary' "$SKILL_SHIM_LOG_DIR/gh.args"
check test "$(awk -v flag="--title" 'prev == flag { print; exit } { prev = $0 }' "$SKILL_SHIM_LOG_DIR/gh.args")" = "fix(api): x"
check grep -q '^body$' "$SKILL_SHIM_LOG_DIR/gh.args"
printf '{\n  "number": 501,\n  "headRefName": "feat/x",\n  "baseRefName": "staging"\n}\n' > "$tmp/fixture/gh/pr.json"
check test "$(gh pr view 501 -R uw-ssec/llteacher --json number)" = "$(cat "$tmp/fixture/gh/pr.json")"
check grep -q 'success' <<<"$(gh run list -R uw-ssec/llteacher --branch staging)"
# gh pr merge: remote staging fast-forwards to the head branch, head dropped
"$SKILL_SHIM_GIT" init -q --bare -b staging "$SKILL_SHIM_REMOTE"
"$SKILL_SHIM_GIT" init -q -b staging repo
"$SKILL_SHIM_GIT" -C repo -c user.name=t -c user.email=t@e commit -q --allow-empty -m base
"$SKILL_SHIM_GIT" -C repo push -q "$SKILL_SHIM_REMOTE" staging
"$SKILL_SHIM_GIT" -C repo checkout -q -b feat/x
"$SKILL_SHIM_GIT" -C repo -c user.name=t -c user.email=t@e commit -q --allow-empty -m feature
"$SKILL_SHIM_GIT" -C repo push -q "$SKILL_SHIM_REMOTE" feat/x
gh pr merge 501 -R uw-ssec/llteacher --squash --delete-branch >/dev/null
check test "$("$SKILL_SHIM_GIT" --git-dir="$SKILL_SHIM_REMOTE" rev-parse staging)" = "$("$SKILL_SHIM_GIT" -C repo rev-parse feat/x)"
check_not "$SKILL_SHIM_GIT" --git-dir="$SKILL_SHIM_REMOTE" show-ref --verify --quiet refs/heads/feat/x

# pixi: success by default, verify fails on the fixture flag, -e is dropped
check test "$(pixi --version)" = "pixi 0.81.0"
check pixi run verify >/dev/null
touch "$tmp/fixture/pixi/verify-fails"
check_not pixi run verify >/dev/null
rm "$tmp/fixture/pixi/verify-fails"
check grep -q 'inspect-smoke in default' <<<"$(pixi run -e evals inspect-smoke)"

# npm: workspace flags ignored, failure flags honoured
check grep -q '42 passed' <<<"$(npm test --workspace=llteacher-web)"
check grep -Eq '^[0-9]+ npm test --workspace=llteacher-web' "$SKILL_SHIM_LOG_DIR/npm.log"
touch "$tmp/fixture/npm/test-fails"
check_not npm test >/dev/null
rm "$tmp/fixture/npm/test-fails"
touch "$tmp/fixture/npm/typecheck-fails"
check_not npm run typecheck >/dev/null
rm "$tmp/fixture/npm/typecheck-fails"
touch "$tmp/fixture/npm/tutor-regression"
check_not npm run tutor:eval >/dev/null
rm "$tmp/fixture/npm/tutor-regression"
touch "$tmp/fixture/npm/docker-down"
check_not npm run aws:local:up >/dev/null 2>&1
rm "$tmp/fixture/npm/docker-down"
check grep -q 'localhost:8080' <<<"$(npm run aws:local:up)"

# npm run node:serve records whether the gateway URL was set
check_not env -u APP_URL npm run node:serve >/dev/null 2>&1
LLMOXIE_BASE_URL=http://localhost:4000 APP_URL=http://localhost:2311 npm run node:serve >/dev/null
check grep -q 'LLMOXIE_BASE_URL=set .* APP_URL=set' "$SKILL_SHIM_LOG_DIR/npm.env"

# npx drizzle-kit generate: next numbered SQL file + journal entry, from root or apps/web
mkdir -p apps/web/src/db/migrations/meta
printf -- '-- 0\n' > apps/web/src/db/migrations/0000_init.sql
printf -- '-- 1\n' > apps/web/src/db/migrations/0001_idx.sql
cat > apps/web/src/db/migrations/meta/_journal.json <<'JSON'
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    { "idx": 0, "version": "7", "when": 1, "tag": "0000_init", "breakpoints": true },
    { "idx": 1, "version": "7", "when": 2, "tag": "0001_idx", "breakpoints": true }
  ]
}
JSON
npx drizzle-kit generate --name add_due_date >/dev/null
check test -f apps/web/src/db/migrations/0002_add_due_date.sql
check grep -q '"tag": "0002_add_due_date"' apps/web/src/db/migrations/meta/_journal.json
check grep -q '"tag": "0001_idx", "breakpoints": true },' apps/web/src/db/migrations/meta/_journal.json
(cd apps/web && npm run db:generate >/dev/null)
check test -f apps/web/src/db/migrations/0003_generated_change.sql
check_not npx drizzle-kit push 2>/dev/null
# npx turbo delegates without double-logging npm
before_npm="$(wc -l < "$SKILL_SHIM_LOG_DIR/npm.log")"
check grep -q '5 successful' <<<"$(npx turbo typecheck)"
check test "$(wc -l < "$SKILL_SHIM_LOG_DIR/npm.log")" = "$before_npm"

# docker, pulumi, uv
check docker info >/dev/null
touch "$tmp/fixture/docker/down"
check_not docker info 2>/dev/null
pulumi stack ls >/dev/null
check grep -Eq '^[0-9]+ pulumi stack ls' "$SKILL_SHIM_LOG_DIR/pulumi.log"
check grep -q '^OK' <<<"$(uv run python run_tests.py --settings=src.llteacher.test_settings)"

# okf: search from fixture, create/update touch knowledge/, unknown id fails
printf 'decisions/x  Decision  x\n' > "$tmp/fixture/okf/search.txt"
check grep -q 'decisions/x' <<<"$(okf search anything)"
okf create decisions/y --type Decision --title "Y" --desc "why y" --body "Body" --actor a:b >/dev/null
check grep -q '^description: why y' knowledge/decisions/y.md
okf update decisions/y --desc "new desc" --body "more" >/dev/null
check grep -q '^description: new desc' knowledge/decisions/y.md
check grep -q '^more' knowledge/decisions/y.md
check_not okf update decisions/missing --desc d 2>/dev/null
check grep -Eq ' okf validate' <<<"$(pixi run okf validate --strict --drift; cat "$SKILL_SHIM_LOG_DIR/okf.log")"

# git wrapper logs then delegates; forbidden shim logs then fails
check grep -q 'git version' <<<"$("$here/git" --version)"
check grep -Eq '^[0-9]+ git --version' "$SKILL_SHIM_LOG_DIR/git.log"
check_not "$here/forbidden" install x 2>/dev/null
check test -s "$SKILL_SHIM_LOG_DIR/forbidden.log"

if [ "$fails" -eq 0 ]; then echo "shims ok"; else echo "$fails shim checks failed"; exit 1; fi
