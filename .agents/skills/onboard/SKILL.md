---
name: onboard
description:
  Use when someone is new to LLTeacher and needs to get up to speed — a new
  contributor's first session, "help me understand this project", "how does this
  work", "where do I start", or handing the repo to someone who has never worked
  in it. Covers machine setup, what the product does, the architecture, and the
  must-knows that trip people up.
---

# Onboard

Take a newcomer from a fresh clone to oriented: their machine passes the gate,
and they can explain what LLTeacher does, how a request flows through it, which
rules a change must keep, and which traps will quietly mislead them.

This is a guided session, not a document to paste. Work **one stage at a time**
and wait for the person to confirm before moving on. Answer "what is" and "why"
questions from project memory (`pixi run okf show <id>`), not from your own
recollection, and send them to the source so they can find it again.

Start by asking two things, because they shape stages 3 and 5:

1. What will you work on first? (student app, instructor console, API/data,
   tutor/LLM behavior, knowledge base, infra/deploy, or not sure yet)
2. Do you have Docker installed? (needed only for DB-backed tests, local AWS,
   and the Harbor skill evals)

## Stage 1 — Set up the machine

Prerequisites, checked in this order:

| Tool               | Check            | Needed for                              |
| ------------------ | ---------------- | --------------------------------------- |
| git                | `git --version`  | everything                              |
| pixi ≥ 0.49        | `pixi --version` | developer tooling (pre-commit, gh, okf) |
| Node 24 (`.nvmrc`) | `node --version` | the apps, infra, and tutor evals        |
| Docker (optional)  | `docker info`    | local Postgres, Floci, Harbor evals     |
| uv (optional)      | `uv --version`   | only the legacy Django tests            |

Missing pixi: https://pixi.sh/latest/#installation. Wrong Node: install 24
(`nvm use` reads `.nvmrc`). Then, from the repository root:

```bash
pixi install                  # pre-commit, gh, okf — developer tooling only
npm ci                        # the TypeScript workspaces, from the lockfile
pixi run pre-commit-install   # hooks on every commit
pixi run verify > /tmp/verify.log 2>&1; echo "exit=$?"; tail -15 /tmp/verify.log
```

SSEC contributors also run the SSEC onboarding flow:
`pixi install -e onboard && pixi run -e onboard onboard` (see
`.agents/rules/onboarding.md`).

**Gate:** `pixi run verify` exits 0. Do not move on until it does — every later
stage assumes a working setup. A TS2307 "Cannot find module" error means stale
`node_modules`: rerun `npm ci`. Anything else:
`.agents/rules/troubleshooting.md`.

Running the app itself (API plus two Vite servers, env vars, a local Postgres)
is the `dev-server` skill; offer it at the end, not now.

## Stage 2 — What LLTeacher is

```bash
pixi run okf show project/llteacher                 # scope, repos, branches
pixi run okf show project/stakeholders-and-context  # who it serves and why
pixi run okf show project/current-state             # done, in flight, open
```

The newcomer leaves this stage knowing:

| Point                 | Why it matters                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What the product does | Instructors author homework in sections; students work each section in a Socratic chat with an LLM tutor that must not hand over answers; instructors review conversations, submissions, and grades. |
| It is mid-port        | The TypeScript stack replaced the Django app as the working product; Django stays only as legacy until cutover.                                                                                      |
| Why it exists now     | UW SSEC is evaluating it as a shared base for several UW AI-tutoring projects, with a fall-quarter pilot as the near-term bar.                                                                       |
| Where things stand    | Feature parity has largely landed; the first AWS production release is the active frontier.                                                                                                          |

## Stage 3 — How it works

Point at `.agents/rules/repository-map.md` for the tree instead of narrating it,
then read the architecture from memory:

```bash
pixi run okf show architecture/system-overview
pixi run okf show architecture/request-path
pixi run okf show architecture/llm-tutor-pipeline
pixi run okf show architecture/data-model-multi-tenancy
```

The mental model to leave them with:

- **One process, three surfaces.** `apps/web` holds the student React SPA _and_
  the only backend (a Hono API under `/api`); `apps/admin` is the instructor SPA
  under `/admin` with no server of its own; `packages/ui` is shared. In
  production one Node process on port 8080 serves all three; in development they
  run as the API on 3000 plus Vite on 2311 (web) and 2312 (admin).
- **A tutor turn:** the chat route checks auth and ownership, loads recent
  history, resolves the LLM config (homework → course → org default; the default
  is UW's LLMoxie gateway), assembles the system prompt (template, section
  content, knowledge, guardrail), streams the model with tools (definitions, R
  code in the browser via WebR, hints, knowledge search), and persists the reply
  with a cost log.
- **Data:** PostgreSQL with pgvector, schema in Drizzle (`apps/web/src/db`).
  Every row belongs to a course or organization; repositories take a branded
  scope, so tenancy is a compile-time requirement.
- **Course knowledge** is an OKF bundle per course, searched by the pinned `okf`
  binary and snapshotted to S3 — not vector RAG.
- **Deploy:** AWS ECS Fargate + RDS + S3 via Pulumi (`infra/`); a `v*` tag runs
  the release workflow, which migrates before activating the new version. Floci
  emulates it locally.

Then the area they named, from this map:

| Working on           | Read next (`pixi run okf show <id>`)                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Student app          | `architecture/request-path`, `decisions/webr-self-hosted-client-side-r`, `facts/code-dev-ports-and-proxy`                       |
| Instructor console   | `architecture/admin-console`, `decisions/course-membership-roles`                                                               |
| API / data           | `architecture/auth-and-authorization`, `requirements/tenant-scoped-data-access`, `facts/migration-index-collision-convention`   |
| Tutor / LLM behavior | `decisions/llm-provider-gateway-and-failover`, `decisions/prompt-template-most-specific-wins`, `architecture/eval-harness`      |
| Knowledge base       | `architecture/knowledge-base-okf`, `decisions/okf-bundle-knowledge-base`, `requirements/single-writer-knowledge-and-extraction` |
| Infra / deploy       | `architecture/infra-topology`, `architecture/ci-release-pipeline`, `decisions/tag-gated-aws-release-pipeline`                   |

For "why is it like this?" use `pixi run okf search "<topic>"`; the decisions
record what was rejected and where the code departed from its spec.

## Stage 4 — Must-knows

Walk these; each one has bitten someone. Correct misunderstandings with the
concept id, not a paraphrase.

**Rules a change must keep** (`pixi run okf search --for-path <file>` shows the
ones governing a file before you edit it):

| Must-know                                                                         | Source                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| Every query is tenant-scoped; routes never touch tables directly                  | `requirements/tenant-scoped-data-access`        |
| Identity PII is encrypted at rest; lookups use blind indexes                      | `requirements/identity-pii-encrypted-at-rest`   |
| Migrations run before new code serves; old code must survive the new schema       | `requirements/migrate-before-deploy`            |
| Production secrets live only in the GitHub `production` environment               | `requirements/production-secrets-handling`      |
| FERPA-related items are open and on hold — ask before touching student-data flows | `requirements/ferpa-data-protection-open-items` |

**Traps:**

- `gh` without `-R uw-ssec/llteacher` talks to the upstream fork. PRs target
  `staging`, never `llteacher01`.
- A `v*` tag **is** a production deploy (the `release` skill).
- About 489 web tests skip silently without `DATABASE_URL`; a local green is not
  proof for repository or SQL changes
  (`facts/code-db-tests-skip-without-database-url`).
- An unset `LLMOXIE_BASE_URL` sends LLM traffic to the production gateway
  (`facts/code-llmoxie-default-base-url-is-prod`).
- Merged migrations are never edited; numbering follows PR-open order
  (`db-migration` skill).
- Many comments and some docs still describe the Cloudflare Workers era; trust
  the code (`facts/code-stale-workers-era-docs`).
- The Django apps are legacy; their tests say nothing about the product
  (`architecture/legacy-django`).

## Stage 5 — How work gets done

The non-negotiables at the top of `AGENTS.md` are the contract; walk them. The
path of a change, one skill each: `verify` → `commit` → `push` → `create-pr`,
with `contribution-discipline.md` read in full before any PR. Area skills:
`run-tests`, `db-migration`, `dev-server`, `local-aws`, `tutor-eval`. AI
assistance is disclosed per `AI_POLICY.md`. Behavioral baseline:
`.agents/rules/working-agreement.md`.

## Orientation check

Close by asking, and correcting from the concept or rule rather than memory:

1. In one sentence, what does LLTeacher do for an instructor and for a student?
2. Which workspace holds the API, and what serves `/admin` in production?
3. What must every repository function receive, and why?
4. You changed a SQL query and `npm test` is green locally. Are you done?
5. Which command decides whether a change is ready, and where do PRs go?

A wrong answer is fine — send them to the source and move on.

## Done

- `pixi run verify` exited 0 on their machine.
- The orientation check is answered.
- They know the next concept or file to open for the work they are picking up,
  and whether to run the `dev-server` skill next.

## Rules

- One stage at a time; dumping everything at once is how people finish
  onboarding having retained nothing.
- Do not skip Stage 1, even if asked: later stages assume a working setup.
  Explain why, then get the gate green.
- Read project memory through `okf show` / `okf search`; never `cat`, `grep`, or
  `find` over `knowledge/` to answer a question.
- Never install with `pip`, `conda`, or a hand-made `venv`; app dependencies
  come from `npm ci` (and `uv` for legacy Django only).
- Never ask the newcomer to paste secrets into the chat; setup needs none.
- If the session turns up something a future newcomer could not derive from the
  code, record it with the `okf-memory` skill.
