---
type: Fact
title: "Lessons for writing skill-eval verifiers, samples and shims"
description: "Rules for Harbor verifiers and Inspect samples carried over from llmoxie-analysis and found while adapting them to llteacher: positive guard checks, state anchors, command-shape regexes, shim delegation, pixi task-shell quirks."
tags: [skill-evals, harbor, inspect, verifiers, lessons]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:31:42Z" }
status: stable
governance: constraint
code_refs: ["skill-evals/harbor/**", "skill-evals/inspect/samples/**"]
sources:
  - resource: "uw-ssec/llmoxie-analysis knowledge/project/eval-authoring-lessons.md"
  - resource: "harbor oracle/nop runs on 2026-10-06"
---

## Verifiers (`skill-evals/harbor/tasks/*/tests/test.sh`)

- Every guard needs one positive check (evidence the agent looked: `git status`, `gh pr view`, `docker info`); a verifier of only negatives scores 1.0 for an agent that crashed. Proven by running all tasks under Harbor's `nop` agent: every task must score 0.
- Anchor guards on state (SHA captured by the fixture, file untouched since a `fixture-base` tag), not only on the absence of a command.
- Diff against a fixture tag, not `HEAD`, so an agent that commits is not punished.
- `shim_arg` reads single-line values; match multi-line bodies with line-anchored `shim_args_have`.
- Accept every valid command shape the skill documents: `npx vitest run <file>` and `npm test -- <file>`; `gh ... -R uw-ssec/llteacher` anywhere in the args.

## Shims

- The fake `gh` strips `-R/--repo` before routing but logs it, so verifiers can require the repo flag (the bare-`gh`-hits-upstream trap).
- A shim delegating to another (`npx turbo` → `npm`) sets `SKILL_SHIM_NO_RECORD=1` so the inner call is not double-logged.
- The base image has no Python; fixture and shim helpers are bash 3.2-compatible awk/sed (the journal append in `drizzle_generate`).
- `test_shims.sh` runs on the host without Docker and is part of the coverage test; extend it with every new shim branch.

## Samples (`skill-evals/inspect/samples/*.yaml`)

- A `must` that appears in the input proves nothing; require the prescribed action.
- Write `must_not` as command shapes (`regex:git push[^\\n]*--force`) so a refusal that names the flag passes.
- The smoke run replays author-written answers against author-written rules: it catches broken YAML/regex, never a skill regression. Only `inspect-skill` with a real model measures a skill; real-model scores are noisy between runs.

## Tooling quirks

- pixi tasks run in pixi's own shell: `cp -R src/. dst/` nests the directory; `harbor-sync` uses `cp -R src/* dst/`.
- `pixi run` treats `{{` as a placeholder; call `.pixi/envs/default/bin/<tool>` directly for such arguments.
- Harbor's litellm pins `openai<3`; Inspect's OpenAI providers need `openai>=3.1`. Reach gateways through Inspect's `anthropic` provider.
- Docker is not started at login on macOS: `open -a Docker` before Harbor.
