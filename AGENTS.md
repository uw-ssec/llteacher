# AGENTS.md

Guidance for AI assistants (Claude Code, Codex, Cursor, Copilot, Gemini CLI, and
any other agent harness) working with this repository.

**This file is the entry point and is deliberately short.** It carries only what
every agent needs before doing anything. Detailed rules and conventions live as
separate files under [`.agents/rules/`](.agents/rules/) and are loaded on demand
— read the one whose trigger matches your current task, not all of them.
Repeatable workflows live as skills under [`.agents/skills/`](.agents/skills/).

## What this repository is

LLTeacher v2: an AI tutoring platform for teachers and students. A TypeScript
Turborepo (`apps/web` student app + API, `apps/admin` instructor console,
`packages/ui`, `infra/` Pulumi for AWS ECS Fargate, `evals/` tutor-behavior
evals) that is replacing the legacy Django app
(`apps/{accounts,conversations,homeworks,llm}`, `src/`, `services/`). See
[repository-map.md](.agents/rules/repository-map.md).

## Non-negotiables

These apply to every task, in every session:

1. **Each toolchain owns its own dependencies.** Pixi owns developer tooling
   (`pre-commit`, `gh`, `okf`, the skill-evals environment); npm workspaces own
   the TypeScript apps and infra; uv owns the legacy Django stack. Never run
   `pip`, `conda`, or `venv` directly, and never add an app dependency to
   `pixi.toml`. Run `pixi install` before any other Pixi command.
2. **Verify before you claim.** Never report work as complete, fixed, or passing
   without having run the check and read its output. The agent gate is
   `pixi run verify` (see the `verify` skill); app changes also need the
   relevant `npm test` run (see the `run-tests` skill).
3. **Read project memory first.** Before changing code in an area, run
   `pixi run okf search --for-path <file>` and respect `hold` / `constraint`
   hits. Record durable decisions and non-obvious discoveries through the
   `okf-memory` skill.
4. **Search project memory before answering.** When asked about a topic,
   concept, decision, or piece of project history you are not certain of, run
   `pixi run okf search "<keywords>" --limit 3` and read the hits before
   searching code or git history, or answering from general knowledge. If the
   bundle has nothing, say so, then fall back to other sources.
5. **Change surgically.** Every changed line must trace directly to the request.
   Don't refactor, reformat, or "improve" adjacent code you weren't asked to
   touch.
6. **Ask instead of assuming.** If the request has multiple readings or
   something is unclear, stop and name it — before implementing, not after.
7. **Always pass `-R uw-ssec/llteacher` to `gh`.** A bare `gh issue`/`gh pr`
   resolves to the upstream fork (`RedBeardLab/llteacher`). PRs target
   `staging`.
8. **Never open a PR** without working through
   [`.agents/rules/contribution-discipline.md`](.agents/rules/contribution-discipline.md)
   in full, including human review of the complete diff.

## Rule Index

Load the rule file whose trigger matches what you are about to do.

| Rule file                                                                      | Load when                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [working-agreement.md](.agents/rules/working-agreement.md)                     | Starting any implementation, refactor, or bugfix — the behavioral baseline                  |
| [contribution-discipline.md](.agents/rules/contribution-discipline.md)         | About to commit, open a PR, or asked to "contribute" / "fix some issues"                    |
| [pixi-environments.md](.agents/rules/pixi-environments.md)                     | Running any command, adding a dependency, or editing `pixi.toml`                            |
| [pre-commit-and-quality.md](.agents/rules/pre-commit-and-quality.md)           | Committing, preparing a PR, or claiming checks pass                                         |
| [repository-map.md](.agents/rules/repository-map.md)                           | You need to know what this repo is, where a file lives, or what CI runs                     |
| [onboarding.md](.agents/rules/onboarding.md)                                   | First-time setup, or helping a new contributor get started                                  |
| [troubleshooting.md](.agents/rules/troubleshooting.md)                         | A documented command fails or behaves unexpectedly                                          |
| [mkdocs-okf-knowledge-bundle.md](.agents/rules/mkdocs-okf-knowledge-bundle.md) | Setting up mkdocs to render an OKF-managed knowledge bundle in this repo (optional pattern) |

## Skills

| Skill                                                                | Use when                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `verify`                                                             | Before committing, opening a PR, or claiming a change is done           |
| `run-tests`                                                          | Running TypeScript, infra, or legacy Django tests, or reading a failure |
| `db-migration`                                                       | Changing the Drizzle schema or touching `apps/web/src/db/migrations/`   |
| `local-aws`                                                          | Deploying the AWS-shaped stack locally with Floci, or changing `infra/` |
| `tutor-eval`                                                         | Changing tutor prompts or the LLM client, or the `evals/` workspace     |
| `dev-server`                                                         | Running the web/admin apps locally                                      |
| `okf-memory`                                                         | Reading or recording project decisions in `knowledge/`                  |
| `commit`, `push`, `create-pr`, `merge-pr`, `create-issue`, `release` | Git and GitHub workflow                                                 |
| `clean-branches`, `docs`                                             | Branch hygiene; documentation changes                                   |

Every skill is evaluated by the Inspect and Harbor suites under
[`skill-evals/`](skill-evals/README.md); a new or changed skill updates its
samples and task in the same change.

## Provenance

Adapted from
[uw-ssec/project-template](https://github.com/uw-ssec/project-template). The
behavioral and contribution rules are adapted from two upstream sources:

- [obra/superpowers](https://github.com/obra/superpowers) `CLAUDE.md` — agent
  contribution discipline (`contribution-discipline.md`).
- [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)
  `CLAUDE.md` — behavioral guidelines that reduce common LLM coding mistakes
  (`working-agreement.md`).

## Trust These Instructions

Commands in these instructions were run in this repository. **Only perform
additional searches if:**

- You need information not covered by `AGENTS.md`, `.agents/rules/`, the skills,
  or `knowledge/`
- Instructions appear outdated or produce errors
- You're implementing functionality that changes the build system
