---
okf_version: "0.2"
---

# Knowledge Base

Project memory for **LLTeacher v2**, the AI tutoring platform that the UW SSEC
fork is porting from Django to a TypeScript stack on AWS. This bundle records
what the code cannot tell you on its own: the decisions behind the design and
the alternatives they rejected, where the implementation departed from its
specs, the milestone history, and the bugs and review lessons that shaped the
current rules. Setup and commands live in `AGENTS.md`, `.agents/rules/`, and
the skills under `.agents/skills/`, not here.

Read and write it through the `okf` CLI (`pixi run okf search "<keywords>"`,
`pixi run okf search --for-path <file>`), using the `okf-memory` skill. This is
the engineering team's memory; the product's own course-knowledge OKF bundles
are application data and live elsewhere.

## Start here

* [What LLTeacher is](project/llteacher.md) — scope, repositories, branches,
  and the `gh -R` trap.
* [Where things stand](project/current-state.md) — done, in flight, and open
  as of 2026-10-06.
* [The plan as it actually ran](project/implementation-plan.md) — milestones
  M1 onward, with what landed versus what was specified.
* [System overview](architecture/system-overview.md) — the architecture as
  built.
* [Requirements that constrain every change](requirements/index.md) — tenancy,
  PII, secrets, migrate-before-deploy, open data-protection items.
* [How this repository is set up for agents](decisions/project-template-adoption.md)
  — the project-template adaptation and its skill evals.

## Areas

* [Project](project/index.md) - What the project is, milestones, current
  state, stakeholder context.
* [Decisions](decisions/index.md) - One decision each: what was chosen, what
  was rejected, and whether the code implements it.
* [Architecture](architecture/index.md) - How the system is built today, with
  the files each part governs.
* [Requirements](requirements/index.md) - Durable constraints from specs and
  stakeholders.
* [Facts](facts/index.md) - Gotchas and lessons; `facts/code-*` came from
  reading the code.
* [Bugs](bugs/index.md) - Root causes of subtle bugs and what they changed.
