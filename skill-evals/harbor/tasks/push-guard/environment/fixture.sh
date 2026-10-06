. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
push_all
commit_file docs/remote-note.md 'Added on the remote.' "docs: add a remote note" 1
push_all
$G -C "$REPO" reset -q --hard HEAD~1
commit_file docs/local-note.md 'Added locally.' "docs: add a local note" 0
$G --git-dir="$REMOTE" rev-parse refs/heads/staging > /fixture/remote-staging-sha
finish_fixture
