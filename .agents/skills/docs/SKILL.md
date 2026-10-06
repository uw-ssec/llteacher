---
name: docs
description:
  Use when work completed in this session needs writing up — a new or changed
  architecture, a schema change, an operational procedure, or a decision that
  belongs in docs/ (and its durable "why" in the knowledge/ bundle).
---

# Docs

Write or update documentation under `docs/` for recent work. There is no docs
site build; `docs/` is plain Markdown read on GitHub, indexed by
`docs/README.md` and one `README.md` per section.

## Arguments

Optional: a topic, a section, or "all".

## Instructions

1. **Gather context** — run in parallel:

   - `git log --oneline -20` and `git log --oneline --since="8 hours ago"`
   - `git diff staging...HEAD --stat` (on a feature branch)
   - Read `docs/README.md` and the README of the section you will touch
   - `pixi run okf search "<topic>"` for decisions already recorded

2. **Pick the place** — update an existing doc before creating one:

   | Content                                       | Location                                              |
   | --------------------------------------------- | ----------------------------------------------------- |
   | How a cross-cutting part works _today_        | `docs/architecture/<topic>.md` + row in its README    |
   | A decision with lasting consequences          | `docs/adr/NNNN-<slug>.md` (next number, `status:`)    |
   | Design spec before implementation             | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` |
   | Implementation plan                           | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`        |
   | Operator procedure (tokens, secrets, deploys) | `docs/operations/<topic>.md`                          |
   | UI components and tokens                      | `docs/design-system/`                                 |
   | Infra usage                                   | `infra/README.md`                                     |

3. **Write it** — start with a level-1 heading and a one-to-two sentence
   summary; tables for env vars and config; Mermaid (`graph TD`,
   `sequenceDiagram`, `erDiagram`) for flows, edges labelled with the mechanism.
   Architecture docs describe current behavior, not aspirations. Decisions use
   Decision / Why / Result (or the ADR's existing sections).

4. **Index it** — every new file gets a row in its section's `README.md`
   (`docs/architecture/README.md`, `docs/README.md` for a new section). Use
   relative links.

5. **Record the why in project memory** — a decision, rejected alternative, or
   gotcha also goes into `knowledge/` through the `okf-memory` skill, with
   `sources` pointing at the doc.

6. **Verify** — every relative link you added resolves (`ls <path>` for each),
   the new file is listed in its section README, and `pixi run pre-commit`
   passes for staged files.

7. **Report** — files created or updated, index rows added, the okf concept ids
   touched, and the verification output.

## Rules

- Never delete existing documentation — update or extend it. Superseded specs
  and plans stay; add a note pointing at what replaced them.
- Never renumber or rewrite an accepted ADR's decision; supersede it with a new
  ADR.
- Date-stamp specs and plans (`YYYY-MM-DD`).
- `docs/notes/` holds meeting transcripts and is gitignored; never move content
  from it into tracked docs verbatim, and never name private individuals.
- NEVER include credentials, account IDs, ARNs, or student data.
