. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
push_all
$G -C "$REPO" checkout -q -b feat/merged-thing
commit_file apps/web/src/merged.ts 'export const merged = 1;' "feat: merged work" 3
$G -C "$REPO" push -q -u origin feat/merged-thing
$G -C "$REPO" checkout -q staging
$G -C "$REPO" merge -q --ff-only feat/merged-thing
$G -C "$REPO" push -q origin staging
$G -C "$REPO" branch -q llteacher01 staging~1
$G -C "$REPO" push -q origin llteacher01
$G -C "$REPO" checkout -q -b feat/stale-thing staging
commit_file apps/web/src/stale.ts 'export const stale = 1;' "feat: stale work" 40
$G -C "$REPO" push -q -u origin feat/stale-thing
$G -C "$REPO" checkout -q -b feat/gone-thing staging
commit_file apps/web/src/gone.ts 'export const gone = 1;' "feat: gone work" 2
$G -C "$REPO" push -q -u origin feat/gone-thing
$G --git-dir="$REMOTE" branch -D feat/gone-thing
$G -C "$REPO" checkout -q -b feat/active-thing staging
commit_file apps/web/src/active.ts 'export const active = 1;' "feat: active work" 1
$G -C "$REPO" push -q -u origin feat/active-thing
$G -C "$REPO" checkout -q staging
$G -C "$REPO" fetch -q --prune
mkdir -p /fixture/gh
printf '#5\tfeat: gone work\tfeat/gone-thing\tMERGED\n' > /fixture/gh/merged.txt
finish_fixture
