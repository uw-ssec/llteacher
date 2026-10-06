---
type: Fact
title: "Repo-root CLAUDE.md describes the Django legacy app, not the live stack"
description: "Until 2026-10-06 the repo-root CLAUDE.md described the Django legacy app, misleading agents; it now points at AGENTS.md."
tags: [docs, onboarding, agents, legacy]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:36Z" }
status: stable
governance: constraint
code_refs: [CLAUDE.md, AGENTS.md]
sources:
  - resource: "PR #457"
  - resource: "issue #65"
  - resource: "issue #108"
---

## Fact

The repo-root `CLAUDE.md` is a "LLTeacher v2 Project Guide" for **Django**: Django views with dataclasses, `@teacher_required` decorators, `uv run python run_tests.py --settings=src.llteacher.test_settings`, and a "Missing Views to Implement" list. PR #457 called this out: the file is stale, and `package.json` itself says "Django legacy lives at apps/, src/, services/ until cutover". Every M1–M12 PR landed on the TypeScript stack.

## Where things actually live

- `apps/web`: Hono API plus the React student chat (Node 24, Drizzle, `src/db/migrations`, `scripts/migrate.ts`, `scripts/seed.ts`).
- `apps/admin`: React instructor console.
- `packages/ui`: shared components and the generative-UI renderer registry.
- `infra`: Pulumi program, account bootstrap and release scripts.
- `docs/superpowers/plans` and `docs/superpowers/specs`: per-feature plans and specs, which carry the actual design decisions.
- Django legacy (still present): `apps/accounts`, `apps/conversations`, `apps/homeworks`, `apps/llm`, `src/`, `services/`, `manage.py`, `run_tests.py`, `templates/`, `static/`. Django still serves the live stats course until the ETL (#64) and archive (#65) are done, per #163's context (inferred to still hold).

## Guidance for agents

- Do not follow the root `CLAUDE.md` workflow for new work. Use npm workspace scripts and `turbo` (for example `npm test`, `npm run typecheck`, `npm -C infra test`).
- #65 (cutover) is meant to update docs and CI to the TypeScript monorepo. Until then, cross-check any instruction file against `package.json` and recent PRs.
- Note: the `llteacher01` branch on origin is also Django-era (see project/llteacher). Base work on `staging`.

## Resolved

On 2026-10-06 the project-template adoption replaced the root `CLAUDE.md` with `@AGENTS.md`, so Claude Code now loads the current agent entry point. The Django-era test command it held is preserved in the `run-tests` skill's legacy section.

# Related Concepts
- [Adopt uw-ssec/project-template with pixi scoped to developer tooling](../decisions/project-template-adoption.md): Resolved by the template adoption
