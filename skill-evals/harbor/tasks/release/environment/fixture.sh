. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
$G -C "$REPO" tag -a v0.1.9 -m "v0.1.9"
commit_file apps/web/src/server/routes/homeworks.ts 'export const label = 1;' "feat(api): label homeworks without a due date" 2
commit_file apps/web/src/server/routes/homeworks.test.ts 'export {};' "fix(api): handle a null due date" 1
push_all
$G -C "$REPO" push -q origin --tags
$G -C "$REPO" tag -a v9.9.9-local -m "stray local tag"
finish_fixture
