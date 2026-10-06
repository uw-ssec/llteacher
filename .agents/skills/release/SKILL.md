---
name: release
description:
  Use when cutting a new LLTeacher version — picking the next vX.Y.Z tag on
  staging, which triggers the production release workflow (image build, smoke
  test, approval-gated Pulumi deploy to AWS).
---

# Release

In this repository **a tag is a production deploy.** Pushing a `v*` tag runs
`.github/workflows/release.yml`: it tests the release artifact against
PostgreSQL, builds and smoke-tests the `Dockerfile.aws` image, then waits on the
`production` GitHub environment approval before Pulumi deploys it to AWS ECS,
runs the candidate's migrations, and activates it. There is no `CHANGELOG.md`;
the GitHub release notes are the changelog.

## Arguments

Optional: `patch`, `minor`, or `major`. Defaults to analyzing commits.

## Instructions

1. Determine the bump from commits since the last tag
   (`git log --oneline $(git describe --tags --abbrev=0)..origin/staging`):
   - `major`: breaking changes (`!` or `BREAKING CHANGE`)
   - `minor`: new features (`feat:`)
   - `patch`: fixes, refactors, docs, chores, infra fixes
2. Current version: `git tag --sort=-v:refname | head -1` (tags are `vX.Y.Z`).
3. Verify readiness — stop and say why if any fails:
   - `git fetch origin --tags` and
     `git checkout staging && git pull origin staging`
   - `git status` shows no uncommitted changes
   - CI on `staging` HEAD is green:
     `gh run list -R uw-ssec/llteacher --branch staging --limit 5`
   - No pending migration is half-merged (see the `db-migration` skill)
4. Show the user the commit list and the proposed tag, and **ask for explicit
   confirmation that they want a production deploy.** Do not continue without
   it.
5. Tag the `staging` HEAD and push only that tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. Watch the run and report where it stopped:

   ```bash
   gh run list -R uw-ssec/llteacher --workflow release.yml --limit 1
   gh run watch -R uw-ssec/llteacher <run-id>
   ```

   The deploy job pauses for the `production` environment approval; a human
   approves it in GitHub. Say so rather than waiting silently.

7. After a successful deploy, create the GitHub release notes:

   ```bash
   gh release create vX.Y.Z -R uw-ssec/llteacher --title "vX.Y.Z" --generate-notes
   ```

8. Confirm: "Released vX.Y.Z — <run URL>, <release URL>".

## Version Guidelines

| Bump            | When                               | Example             |
| --------------- | ---------------------------------- | ------------------- |
| `patch` (0.1.X) | Bug fixes, docs, chores, refactors | `v0.1.8` → `v0.1.9` |
| `minor` (0.X.0) | New features, non-breaking changes | `v0.1.9` → `v0.2.0` |
| `major` (X.0.0) | Breaking changes, major rewrites   | `v0.2.0` → `v1.0.0` |

## Rules

- NEVER push a tag without the user's explicit go-ahead for a production deploy
  in this session; a previous approval does not carry over.
- Tag only `staging` HEAD after it is green; never tag a feature branch or
  `llteacher01`.
- Push the single tag (`git push origin vX.Y.Z`), never `--tags` or
  `--follow-tags` (stray local tags would deploy too).
- Never delete or move a pushed tag to "redo" a release; cut the next patch.
- Never approve the `production` environment on the user's behalf, and never run
  `pulumi up` against the production stack by hand.
- NEVER add "Generated with" or similar marketing lines to release notes, and
  never include secrets, ARNs, or account IDs.
