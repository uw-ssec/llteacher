. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
push_all
$G -C "$REPO" checkout -q -b feat/due-date-label
commit_file apps/web/src/server/routes/homeworks.ts 'export const x = 1;' "feat(api): add the due-date label" 1
commit_file apps/web/src/server/routes/homeworks.test.ts 'export {};' "test(api): cover the due-date label" 0
finish_fixture
