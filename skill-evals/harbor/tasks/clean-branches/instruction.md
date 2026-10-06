Clean up the git branches in the repository at `/app`.

Argument: `merged` and `orphaned`.

The user has already confirmed the deletions, including force-deleting
`feat/gone-thing`: its PR was squash-merged (`gh pr list --state merged` shows
it), so `git branch -d` will refuse it. Keep stale and active branches.
