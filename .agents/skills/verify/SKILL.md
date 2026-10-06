---
name: verify
description:
  Use before committing, opening a pull request, or claiming a change is
  complete, fixed, or passing — the single quality gate for this repository.
---

# Verify

One command, exit 0, plus the tests for whatever app code you changed:

```bash
git add <new files>          # pre-commit sees tracked and staged files only
pixi run verify > /tmp/verify.log 2>&1; echo "exit=$?"; tail -20 /tmp/verify.log
npm test --workspace=<workspace you changed>   # see the run-tests skill
```

`pixi run verify` runs, in order, and stops at the first failure:

| Step               | What it checks                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `pre-commit-all`   | Hooks on the agent/template surface: whitespace, YAML, prettier, codespell, workflow schemas, detect-secrets |
| `okf-validate`     | `okf validate --strict --drift` over `knowledge/`                                                            |
| `skill-evals-test` | Every skill has Inspect samples and a Harbor task; the fake CLIs pass their self-test (`evals` env)          |
| `inspect-smoke`    | Every skill's Inspect samples against canned answers (`evals` env)                                           |
| `app-typecheck`    | `npm run typecheck` — `tsc -b` across every TypeScript workspace                                             |

Tests are not in `verify`: `npm test` takes about a minute, and about 489
`apps/web` tests skip silently without a PostgreSQL (`DATABASE_URL`), so a local
green is weaker than it looks. Run them with the `run-tests` skill and report
the skipped count. Turbo's `^build` only builds upstream workspaces, so also run
`npm run build` when you change client code, Vite config, or `packages/ui`
exports. CI (`.github/workflows/test.yml`) additionally runs the
migration-index-collision check, migrations, a seed smoke test, `npm test`,
`npm run build`, and a Docker image smoke test.

## When a step fails

| Symptom                                                 | Do                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Hook says "files were modified by this hook"            | The hook fixed formatting. `git add` the files and rerun.                        |
| detect-secrets flags a line                             | Remove the secret. Only a reviewed false positive goes into `.secrets.baseline`. |
| okf `gate` or `error` line                              | Fix the concept it names, through the `okf-memory` skill.                        |
| `skill-evals-test` says a skill lacks samples or a task | Add them (see `skill-evals/README.md`); never delete the test.                   |
| `inspect-smoke` sample INCORRECT                        | The smoke answer and the rules disagree; fix whichever is wrong.                 |
| `app-typecheck` error                                   | Fix the type. Stale `node_modules` after a pull: `npm install` first.            |

## Done

Every step ran, the exit code was 0, and the final lines are pasted into the
commit body or the PR's "How to test" section, together with the `npm test`
summary line for the workspaces you changed. A step you skipped is a step that
failed; say which and why.

## Rules

- Never read the gate through a pipe (`pixi run verify | tail`): the pipe hides
  the exit code. Capture to a file and check `$?`.
- Never bypass the gate: no `--no-verify`, no editing `.pre-commit-config.yaml`,
  `tsconfig*.json`, or the skill-evals tests to make a failure disappear.
- "Should pass" is not a result. Run it.
