# Pixi Environments & Dependencies

**Load when:** setting up the repo, running any command, adding or changing a
dependency, or editing `pixi.toml`.

## Who owns which dependency

This repository has three toolchains. Each owns its own dependencies; never add
a dependency to the wrong one.

| Toolchain | Manifest                                     | Owns                                                                                        |
| --------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pixi      | `pixi.toml` / `pixi.lock`                    | Developer tooling: pre-commit, `gh`, `okf`, the skill-evals env                             |
| npm       | `package.json` (root + workspaces), lockfile | `apps/web`, `apps/admin`, `packages/*`, `evals`, `infra` (Node >=24)                        |
| uv        | `pyproject.toml` (root + Django workspaces)  | The legacy Django stack: `apps/{accounts,conversations,homeworks,llm}`, `src/`, `services/` |

**Never invoke `pip`, `conda`, or `venv` directly**, and never put an app
dependency in `pixi.toml`. Node comes from the system (`.nvmrc`), not from pixi.
See https://pixi.sh/latest/llms-full.txt for pixi itself.

## Prerequisites

```bash
pixi --version  # v0.49.0 or higher (CI and the devcontainer pin v0.81.0)
node --version  # v24 or higher, for the app tasks
```

If pixi is missing, direct users to https://pixi.sh/latest/#installation.

## Environment Setup (ALWAYS RUN FIRST)

```bash
pixi install            # default environment: pre-commit, gh, okf
pixi install -e evals   # only for skill evals (Python 3.12, inspect-ai, harbor)
npm install             # the TypeScript workspaces
```

`pixi install` is idempotent. The first `pixi run verify` installs the `evals`
environment too, because `verify` depends on two of its tasks.

## Available Environments

1. **`default`** (features: `pre-commit`, `gh-cli`, `okf`) — everyday
   development, the `verify` gate, `okf` project memory.
2. **`onboard`** (features: `pre-commit`, `gh-cli`, `onboard`) — first-time
   setup with ssec-cli. Does **not** include `okf`.
3. **`evals`** (features: `pre-commit`, `gh-cli`, `evals`) — Inspect and Harbor
   skill evals. Its own solve group because harbor needs Python >=3.12 and pins
   `openai<3` through litellm.

## Channels

Conda packages resolve from one channel, `https://prefix.dev/conda-forge` (the
prefix.dev mirror of conda-forge), listed **instead of** the bare `conda-forge`
name. Listing both is a no-op: channel priority makes the anaconda.org copy win.
Channel changes invalidate `pixi.lock`; check the lockfile diff for incidental
bumps.

## Tasks

Run `pixi task list` for all of them. The ones that matter:

| Task                            | What it does                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `verify`                        | The agent gate: pre-commit, okf validate, skill-eval tests + Inspect smoke, `npm run typecheck` |
| `okf-validate`                  | `okf validate --strict --drift` over `knowledge/`                                               |
| `app-typecheck` / `app-test`    | `npm run typecheck` / `npm test` (turbo) with the system Node                                   |
| `pre-commit-all` / `pre-commit` | Hooks on all files / staged files                                                               |
| `-e evals inspect-smoke`        | Every skill's Inspect samples against canned answers (no key)                                   |
| `-e evals inspect-skill`        | One skill against a real model                                                                  |
| `-e evals harbor-oracle`        | Every Harbor task with the oracle agent (needs Docker)                                          |
| `-e evals harbor-agent`         | Every Harbor task with claude-code and a real model                                             |

Extra arguments append to the task command, so
`pixi run -e evals inspect-skill -T name=db-migration --model anthropic/claude-haiku-4-5`
works without a wrapper task.

## Adding Dependencies

```bash
pixi add --feature <feature> <package>         # conda package into a feature
pixi add --feature <feature> --pypi <package>  # PyPI package into a feature
pixi install                                   # after any manual pixi.toml edit
```

Adding tooling needs a reason — see
[contribution-discipline.md](contribution-discipline.md). App dependencies go
through `npm install <pkg> --workspace=<name>` or `uv add`, never pixi.

## GitHub CLI

```bash
pixi run gh <command> -R uw-ssec/llteacher
```

Always pass `-R uw-ssec/llteacher`: the clone has the upstream fork
`RedBeardLab/llteacher` as a remote and a bare `gh issue` resolves there.
`pixi run` treats `{{` as a task-argument placeholder, so a `--template '{{…}}'`
argument fails; use `--json` with `--jq`, or call `.pixi/envs/default/bin/gh`.

## OKF Agent Memory

The `okf` feature installs a binary named **`okf`** (not `okf-agent-memory`):

```bash
pixi run okf version   # 0.5.0 (OKF v0.2 specification) or higher
```

Run it from the repository root, where the bundle path defaults to `knowledge`.
The `okf-memory` skill has the full workflow. `pixi run okf` has the same `{{`
placeholder trap as `gh`: a `--body` mentioning `{{` must go through
`.pixi/envs/default/bin/okf` directly.
