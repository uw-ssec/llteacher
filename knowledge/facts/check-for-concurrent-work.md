---
type: Fact
title: Several sessions work this repository at once; re-check staging before and during an issue
description: "Other sessions and contributors merge to staging in parallel (#481 landed #165 while a duplicate PR was being written); fetch staging and search open and merged PRs for the issue before starting, and again before opening a PR."
tags: [process, concurrency, pull-requests, sessions]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:53:11Z" }
status: stable
governance: context
---

On 2026-10-08 a duplicate implementation of #165 was built and opened as PR #483 while another session merged PR #481 for the same issue, along with #476 (design-system lint) and #478 (Effect 4 handler refactor). #483 was closed as superseded; the work was lost.

## Do this

- **Before starting an issue:** `git fetch origin`, then `gh pr list -R uw-ssec/llteacher --search "<issue number>" --state all` and `gh issue view <n> -R uw-ssec/llteacher` (is it already closed?). Check the milestone's open count too.
- **Before opening the PR:** fetch again and merge `origin/staging` into the branch; look for a new migration index (see the db-migration skill), new lint rules, and refactors of the files you touched.
- **Before merging a PR whose CI ran earlier:** if `staging` moved, merge it in and re-run the affected tests and a forced typecheck locally (`npx turbo typecheck --force`) rather than trusting the old CI result.
- `git stash -u` before switching branches mid-task, and `git stash pop` on return; it carried in-progress #367 work safely across a #442 re-verification.

# Related Concepts
- [Integrating long-open PRs: find what already landed before resolving conflicts](integrating-stale-prs.md): The same staleness, before and after a PR
