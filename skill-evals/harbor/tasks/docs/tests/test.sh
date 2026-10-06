#!/bin/bash
. /usr/local/lib/skill-evals/verify.sh
cd "$REPO"
new_docs="$(repo_git ls-files --others --exclude-standard docs; repo_git diff --name-only --diff-filter=A fixture-base -- docs 2>/dev/null)"
[ -n "$new_docs" ] || fail "no new documentation file under docs/"
for f in $new_docs; do
  case "$f" in */README.md) continue ;; esac
  base="$(basename "$f")"
  grep -q "$base" "$(dirname "$f")/README.md" || fail "$(dirname "$f")/README.md does not index $base"
done
[ -f docs/architecture/db-driver-split.md ] || fail "an existing doc was removed"
grep -q 'db-driver-split.md' docs/architecture/README.md || fail "an existing index row was removed"
pass "new doc written and indexed"
