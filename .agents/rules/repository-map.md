# Repository Map

**Load when:** you need to know what this repository is, where a file lives, or
what CI runs against it.

## Repository Overview

**LLTeacher v2** is an AI-assisted tutoring platform: instructors author
homework, students work through sections in a Socratic chat with an LLM tutor,
and instructors review conversations and submissions. The UW SSEC fork
(`uw-ssec/llteacher`) is porting the original Django app (upstream
`RedBeardLab/llteacher`) to a TypeScript stack deployed on AWS, and evaluating
it as a shared base for several UW AI-tutoring projects.

The _why_ behind the code — decisions, rejected alternatives, milestone history,
known traps — is in the OKF bundle at `knowledge/`. Search it before reading
plan documents: `pixi run okf search "<topic>"`.

- **Languages:** TypeScript (apps, infra), Python (legacy Django, skill evals)
- **Build:** npm workspaces + Turborepo (TS); uv workspaces (Django); Pixi
  (tooling)
- **Deploy:** AWS ECS Fargate + RDS PostgreSQL via Pulumi (`infra/`); Floci for
  a local AWS emulation
- **Branches:** `staging` is the default and PR target; `llteacher01` tracks
  upstream
- **Platforms:** macOS (osx-arm64) and Linux (linux-64, linux-aarch64)

## Project Structure & Key Files

```
.
├── apps/
│   ├── web/                     # Student app + API: Vite/React 19, Hono server, Drizzle ORM (port 2311)
│   │   └── src/db/migrations/   # Drizzle SQL migrations + meta/_journal.json (append-only)
│   ├── admin/                   # Instructor console (port 2312)
│   ├── accounts/ conversations/ homeworks/ llm/   # Legacy Django apps (uv workspaces)
├── packages/ui/                 # Shared React UI components
├── evals/                       # Product evals: tutor-behavior / answer-leakage (npm workspace, vitest)
├── infra/                       # Pulumi program (AWS + Floci), scripts/*.test.sh, vitest
├── src/llteacher/ services/     # Legacy Django project + service layer
├── docs/
│   ├── superpowers/specs/       # Design specs (one per feature, dated)
│   ├── superpowers/plans/       # Implementation plans (M1..M12 milestones, dated)
│   ├── adr/                     # Architecture decision records
│   ├── architecture/            # Architecture notes (tenancy, db driver split, admin console, ...)
│   └── design-system/           # UI design system
├── knowledge/                   # OKF project memory, managed by the okf CLI (okf-memory skill)
├── skill-evals/                 # Inspect + Harbor evals of the agent skills in .agents/skills
├── .agents/
│   ├── rules/                   # On-demand rules referenced by AGENTS.md
│   └── skills/                  # Agent skills (/verify, /run-tests, /db-migration, ...)
├── .github/
│   ├── workflows/test.yml       # CI: typecheck + tests for the TS workspaces
│   ├── workflows/release.yml    # AWS release: image build, Pulumi deploy (approval-gated)
│   ├── workflows/zizmor.yml     # Workflow security lint
│   ├── workflows/skill-evals.yml  # Inspect smoke + Harbor oracle matrix
│   ├── workflows/copilot-setup-steps.yml  # Copilot cloud agent environment
│   └── ISSUE_TEMPLATE/, pull_request_template.md, dependabot.yml, release.yml
├── Dockerfile.aws               # Production image (Node API + built web/admin)
├── package.json turbo.json      # npm workspaces + Turborepo pipeline
├── pyproject.toml uv.lock       # uv workspaces for Django
├── pixi.toml pixi.lock          # Developer tooling environments
├── AGENTS.md CLAUDE.md          # Agent entry point
└── AI_POLICY.md CONTRIBUTING.md CODE_OF_CONDUCT.md
```

## Common commands

| Goal                        | Command                                        |
| --------------------------- | ---------------------------------------------- |
| Agent gate                  | `pixi run verify`                              |
| Typecheck all TS workspaces | `npm run typecheck`                            |
| Test all TS workspaces      | `npm test` (see the `run-tests` skill for env) |
| Dev servers                 | `npx turbo dev` (see the `dev-server` skill)   |
| Apply Drizzle migrations    | `npm run db:migrate` (see `db-migration`)      |
| Local AWS stack             | `npm run aws:local:up` / `verify` / `down`     |
| Tutor-behavior eval         | `npm run tutor:eval` (see `tutor-eval`)        |
| Project memory              | `pixi run okf search "<q>"`                    |

## Continuous Integration & Validation

- **`test.yml`** runs the TypeScript typecheck and test suites; app PRs must
  keep it green.
- **`release.yml`** builds the AWS image and deploys through Pulumi; production
  secrets are owned by GitHub environments (see `knowledge/` and
  `docs/adr/0001-operator-owned-production-secrets.md`). Never trigger it
  without explicit approval.
- **`zizmor.yml`** lints workflow files for security issues; anything under
  `.github/workflows/` must keep it passing.
- **`skill-evals.yml`** runs `pixi run -e evals evals-smoke` (Inspect smoke and
  every Harbor task under the oracle) when skills or evals change.
- **`copilot-setup-steps.yml`** prepares the Copilot cloud agent (pixi from
  `pixi.lock`, warm pre-commit hooks). Keep its `pixi-version` in sync with
  `.devcontainer/Dockerfile`.
- **Dependabot** updates GitHub Actions weekly.

## Further Reading

- SSEC best practices:
  https://rse-guidelines.readthedocs.io/en/latest/llms-full.txt
- `infra/README.md` — local Floci deploys, credentials, the release workflow
- `evals/README.md` — the tutor-behavior eval harness
- `skill-evals/README.md` — the agent-skill evals
