---
type: Fact
title: "Integrating long-open PRs: find what already landed before resolving conflicts"
description: "A PR left open for weeks against fast-moving staging is often partly or wholly superseded; check the issue timeline and the code for each piece first, integrate only what is missing on a fresh branch, and close the rest with a precise comment."
tags: [process, pull-requests, git, merge]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-08T20:53:11Z" }
status: stable
governance: context
---

Learned 2026-10-08 resolving #435, #436 and #412, each about 220 commits behind `staging` and conflicting.

## Procedure that worked

1. **Read the PR's intent, then check each piece against `staging` before touching conflicts.** `gh api repos/uw-ssec/llteacher/issues/<n>/timeline` shows commits that referenced the issue; `git log -S <symbol> origin/staging` and a grep for the PR's new symbols show whether the change already exists. Outcomes:
   - #436: the same fix had landed as 0c9a9f9 with equivalent tests. Closed, nothing to port.
   - #412: all of its code had landed in the M4 closeout (9743dd7), including its own follow-up rename. Closed; the one real gap (no AWS plumbing for `LLM_DEGRADED_MODEL`) was named in the closing comment, not silently built, because it changes the reviewed production input set.
   - #435: the client half was superseded by #286 and per-id callback caching; only the server's review-commit fix was missing. Ported to a fresh branch from `staging`, extended to the two senders added since (#308 conversations, feedback).
2. **Rebuild on a fresh branch, not a conflict resolution of the old one**, then replace the PR branch with `git push --force-with-lease=<branch>:origin/<branch>`. This keeps the PR's discussion while the diff shows only what still matters; rewrite the PR description to list each original piece as integrated or superseded.
3. **Close superseded PRs with a comment naming the commit that superseded each piece** and leave the branch, so the decision is reviewable and reversible.

## Traps

- Squash merges make `git branch -d` refuse the local branch afterwards; confirm `git diff <branch> staging` is empty before `-D`.
- A superseded PR can still carry a real gap (here the AWS input). Name it rather than drop it.

# Related Concepts
- [LLM calls go through the Vercel AI SDK to OpenAI-compatible providers, with LLMoxie as the platform default](../decisions/llm-provider-gateway-and-failover.md): Where the #412 AWS gap is recorded
- [Retry-After reports the time left in the rate-limit window](../decisions/retry-after-remaining-window.md): The one piece of #435 that was integrated
