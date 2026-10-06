# Skill evals

Every agent skill under `.agents/skills/` is evaluated at two levels from the
`evals` Pixi environment. This is separate from `evals/`, the npm workspace that
evaluates the **product's** tutor (answer leakage, Socratic behavior).

| Level | Question                                                             | Framework | Runs in                             |
| ----- | -------------------------------------------------------------------- | --------- | ----------------------------------- |
| Model | With `SKILL.md` in context, does the model answer as the skill says? | Inspect   | `pixi run verify` (mock model)      |
| Agent | Dropped into a sandbox with the skill, does the agent act on it?     | Harbor    | `harbor-oracle` / CI (needs Docker) |

The pattern is adapted from `uw-ssec/llmoxie-analysis`; the reasons for its
shape are recorded in `knowledge/` (`pixi run okf search "skill evals"`).

## Layout

```
skill-evals/
├── inspect/
│   ├── skill_eval.py               # one task for every skill: inject SKILL.md, score by rules
│   └── samples/<skill>.yaml        # user turns + must / must_not rules + canned smoke answer
├── harbor/
│   ├── base/                       # shared image: git, fake gh/pixi/okf/npm/npx/pulumi/docker/uv, all skills
│   │   ├── Dockerfile
│   │   ├── lib/                    # shimlib.sh (+ drizzle_generate), fixture.sh (ts_scaffold), verify.sh
│   │   ├── shims/                  # fake CLIs, git wrapper, forbidden (pip/conda), test_shims.sh
│   │   └── skills/                 # gitignored, filled by harbor-sync
│   └── tasks/<task>/               # one happy-path task per skill + <skill>-guard tasks for NEVER rules
│       ├── task.toml               # environment.skills_dir = "/skills"
│       ├── instruction.md          # pre-answers the confirmations the skill would ask
│       ├── environment/            # Dockerfile FROM the base + fixture.sh
│       ├── solution/solve.sh       # what the oracle agent runs
│       └── tests/test.sh           # reads shim logs and repo state, writes the reward
├── tests/test_coverage.py          # every skill has samples + a task; shims self-test
└── logs/                           # gitignored
```

The fixture repo at `/app` is an llteacher lookalike (`ts_scaffold`): npm
workspaces, `apps/web` with a Drizzle schema and two applied migrations plus
`meta/_journal.json`, `pixi.toml`, and a `knowledge/` bundle. Its default branch
is `staging`, with a real bare remote at `/remote/origin.git`.

## Run

```bash
pixi run -e evals skill-evals-test                                # coverage + shim self-test
pixi run -e evals inspect-smoke                                   # all skills, canned answers, no key
pixi run -e evals inspect-skill -T name=db-migration --model anthropic/claude-haiku-4-5
pixi run -e evals harbor-oracle                                   # build base, run every task with the oracle
pixi run -e evals harbor run -p skill-evals/harbor/tasks/db-migration -a nop -o skill-evals/logs/harbor   # happy-path tasks must score 0
pixi run -e evals harbor-agent -m anthropic/claude-haiku-4-5      # every task with claude-code
pixi run -e evals inspect-view                                    # browse Inspect logs
pixi run -e evals harbor-view                                     # browse Harbor trajectories
```

Harbor needs a running Docker daemon (`open -a Docker` on macOS, then wait for
`docker info`). Real-model runs read `ANTHROPIC_API_KEY` (and
`ANTHROPIC_BASE_URL` for a LiteLLM gateway such as LLMoxie) from the
environment.

## How scoring works

Inspect: a sample's reply is CORRECT only if every `must` matches and no
`must_not` matches. Plain strings are case-insensitive substrings; a `regex:`
prefix is a case-sensitive multiline regex. Write forbidden rules as command
shapes (`regex:git push[^\n]*--force`) so a reply that names the flag while
refusing it still passes. The smoke run replays the author's `smoke_answer`, so
it catches broken YAML or regexes, never a skill regression; only a real-model
run measures the skill.

Harbor: the fake CLIs append every call to `/var/log/skill-shims/<tool>.log`
(timestamped, one line) and `<tool>.args` (one argument per line). Behaviour
flags live under `/fixture/<tool>/` (for example `/fixture/pixi/verify-fails`,
`/fixture/npm/test-fails`, `/fixture/npm/tutor-regression`,
`/fixture/docker/down`). `npx drizzle-kit generate` really writes the next
`NNNN_<name>.sql` and its journal entry, so migration tasks can check files.
`tests/test.sh` sources `verify.sh` and asserts with `shim_called`,
`shim_not_called`, `shim_arg`, `shim_args_have`, `before`, `branch_exists` and
friends. Guard tasks leave out the confirmation and reward the agent for
stopping; every guard also has one positive check, so a do-nothing agent cannot
pass it.

## Adding or changing a skill

1. Write `.agents/skills/<name>/SKILL.md`.
2. Add `skill-evals/inspect/samples/<name>.yaml`: three to five samples, each
   aimed at one rule of the skill, at least one that tempts a forbidden action.
3. Add `skill-evals/harbor/tasks/<name>/` from an existing task (the boilerplate
   `task.toml` and `environment/Dockerfile` are identical across tasks). Add a
   `<name>-guard` task if the skill has a NEVER rule.
4. `pixi run verify` (coverage test and Inspect smoke), then
   `pixi run -e evals harbor-oracle`, and a `nop` run to prove the verifier
   rejects inaction.
