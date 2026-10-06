---
type: Decision
title: Adopt uw-ssec/project-template with pixi scoped to developer tooling
description: "On 2026-10-06 llteacher adopted the SSEC project template: AGENTS.md, rules, skills, OKF knowledge/ bundle, skill evals; pixi owns tooling only, npm and uv keep the app, hooks scope to the template surface."
tags: [project-template, pixi, agents, skills, pre-commit, okf]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:36Z" }
status: stable
governance: constraint
code_refs: [pixi.toml, .pre-commit-config.yaml, AGENTS.md, CLAUDE.md, ".agents/rules/**", ".agents/skills/**", .gitignore]
sources:
  - resource: "https://github.com/uw-ssec/project-template"
  - resource: "https://github.com/uw-ssec/llmoxie-analysis"
  - resource: branch feat/project-template-adoption
---

## Decision

The repository follows [uw-ssec/project-template](https://github.com/uw-ssec/project-template), adapted on 2026-10-06 (branch `feat/project-template-adoption`), with `uw-ssec/llmoxie-analysis` as the reference for the skill-eval pattern.

## Adaptations that differ from the template

| Template default | llteacher choice | Why |
| --- | --- | --- |
| Pixi is the only package manager | Pixi owns developer tooling (pre-commit, gh, okf, skill evals); npm workspaces own the TypeScript apps and infra; uv owns legacy Django | The app already has two working toolchains and CI built on them; moving them into pixi would be a rewrite with no user benefit |
| pre-commit over every file | Hooks scoped by a top-level `files:` regex to the agent/template surface (AGENTS.md, community files, pixi.toml, .agents/, .claude hooks, .devcontainer/, .github/, knowledge/, skill-evals/) | The TS and Django code was never formatted by prettier/codespell; widening scope means a repo-wide reformat in its own PR |
| `evals/` for skill evals | `skill-evals/` | `evals/` is already the product's tutor-behavior npm workspace (#89); mixing agent-skill evals into it would blur product and tooling evals |
| PRs target `main` | PRs target `staging`; `llteacher01` tracks upstream | Every merged PR since #106 targets staging |
| `release` skill: changelog, zips | `release` skill: a `v*` tag on staging *is* a production deploy (release.yml, approval-gated) | No CHANGELOG; tags trigger AWS deploys |
| `docs` skill: mkdocs | `docs` skill: plain Markdown under docs/ indexed by section READMEs | llteacher has no docs site |
| `pixi run pre-commit-all` gate | `pixi run verify`: pre-commit, okf validate, skill-eval coverage + Inspect smoke, `npm run typecheck` | One command an agent must pass; tests stay separate because DB tests need Postgres |

The root `CLAUDE.md` (a stale Django-era guide) was replaced by `@AGENTS.md`.

## Project-specific skills

`verify`, `run-tests`, `db-migration`, `local-aws`, `tutor-eval`, `dev-server`, each with Inspect samples and a Harbor task (plus guards for NEVER rules).

## Two okf versions

The tooling okf (`okf-agent-memory` 0.5 via pixi) reads this bundle. The product pins okf 0.3.0 in test.yml and Dockerfile.aws for course knowledge bundles. Bumping one does not imply bumping the other.

## Left for a human

The Claude Code wiring (`.claude/skills` symlink to `.agents/skills`, `.claude/settings.json` with the okf `--for-path` PreToolUse hook, `.claude/hooks/okf-for-path.sh`) was blocked as agent self-modification and must be added by a person; `.gitignore` already un-ignores those paths.

# Related Concepts
- [Agent-skill evaluation with Inspect and Harbor](../architecture/skill-evals.md): The skill-eval layer the template adoption added
