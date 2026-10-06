---
type: Architecture
title: Agent-skill evaluation with Inspect and Harbor
description: "Every skill in .agents/skills is checked twice: Inspect replays SKILL.md-in-context samples scored by must/must_not rules, and Harbor runs agents in Docker against an llteacher lookalike with fake CLIs that log every call."
tags: [skill-evals, inspect, harbor, skills, testing]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T23:02:01Z" }
status: stable
governance: context
code_refs: ["skill-evals/**", .github/workflows/skill-evals.yml]
sources:
  - resource: skill-evals/README.md
  - resource: skill-evals/logs harbor-oracle and nop runs on 2026-10-06
---

## Shape

| Level | Tool | Where | Gate |
| --- | --- | --- | --- |
| Model | Inspect (`skill-evals/inspect/skill_eval.py`, `samples/<skill>.yaml`) | `pixi run -e evals inspect-smoke` (canned answers) / `inspect-skill` (real model) | smoke is part of `pixi run verify` |
| Agent | Harbor (`skill-evals/harbor/tasks/<task>/`) | `harbor-oracle` (oracle agent), `harbor-agent` (claude-code) | CI `skill-evals.yml` on skill/eval changes |

A coverage test (`skill-evals/tests/test_coverage.py`) fails when a skill lacks samples or a task, when a task is incomplete or does not deliver `/skills`, or when the fake-CLI self-test fails.

## Harbor sandbox

The base image (`llteacher-skill-evals-base:local`) carries git and fake `gh`, `pixi`, `okf`, `npm`, `npx`, `pulumi`, `docker`, `uv`, plus a logging `git` wrapper and a `forbidden` stub for pip/pip3/conda. Every call lands in `/var/log/skill-shims/<tool>.log` and `.args`. Behaviour flags under `/fixture/<tool>/` make a step fail (verify, tests, typecheck, tutor regression, Docker down). `npx drizzle-kit generate` really writes the next `NNNN_<name>.sql` and journal entry so migration tasks check files; `npm run node:serve` records whether `LLMOXIE_BASE_URL` and `APP_URL` were set.

The fixture (`ts_scaffold`) is an llteacher lookalike on branch `staging` with a bare remote: npm workspaces, `apps/web` with a Drizzle schema, two applied migrations and the journal, pixi.toml, knowledge/.

## Baseline (2026-10-06)

23 tasks (15 happy-path, 8 guards): oracle 23/23 reward 1.0; nop 23/23 reward 0.0. Inspect smoke: 48 samples, accuracy 1.0. No real-model run yet.

Added 2026-10-06 with the `onboard` skill: 24 tasks, 53 Inspect samples; the `onboard` task scores 1.0 under oracle and 0.0 under nop.

# Related Concepts
- [Lessons for writing skill-eval verifiers, samples and shims](../facts/skill-evals-authoring-lessons.md): Rules for writing its verifiers and samples
- [Tutor-behavior eval harness (evals/)](eval-harness.md): Not to be confused with the product's tutor eval
