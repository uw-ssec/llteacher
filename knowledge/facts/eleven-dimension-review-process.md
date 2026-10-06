---
type: Fact
title: "Review process: 11-dimension audits, findings filed as issues, live-DB verification"
description: "Large PRs get an 11-dimension audit (security first and last); each finding becomes its own issue with severity, and fixes are verified against a live Postgres rather than taken on the writeup's word."
tags: [process, code-review, quality, testing]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: constraint
sources:
  - resource: "PR #127"
  - resource: "PR #212"
  - resource: "PR #413"
  - resource: "PR #432"
  - resource: "PR #458"
  - resource: "PR #461"
  - resource: "issue #108"
  - resource: "issue #184"
---

## The pattern

The team runs a consistent, heavy review process on milestone-size PRs:

- **An 11-dimension audit**: security, functionality, reliability, maintainability, performance, scalability, compatibility, flexibility, usability, accessibility, plus a closing security re-pass over the other findings and the diff. Security is examined first and last (PR #461 review). Findings carry codes and severities such as `REL-001`, `SCL-001`, `CMP-001` with L×I ratings, and 🔴/🟠/🟡 blocking tiers.
- **Each finding becomes its own issue** with full evidence (file:line, a repro, a quoted SDK source). PR #127 alone produced #129–#140 and #146–#152. M4 PR4 produced #414–#431, which PR #432 then fixed in one pass. The issue tracker therefore holds a lot of precise root-cause history worth searching before you change code.
- **Disposition comments.** The author replies with a numbered list mapping each finding to a commit ("No finding was declined", PR #458), or triages it to a milestone with a reason. The `non-blocking` label marks findings deferred on purpose.
- **Empirical verification.** Reviewers stand up a real pgvector Postgres, run migrations from scratch, mutation-check tests (a test must fail when the org filter is removed) and run suites three times to catch flakes. Claims are "checked, not taken on the writeup's word".
- **Reviewers can be wrong.** In #138 the reviewer's round-2 claim was reversed in round 3 after re-testing. Trust the experiment over the assertion.
- **Implementation style.** M4 work used subagent-driven development: a fresh implementer per issue, an independent reviewer, fix loops, then a whole-branch review. Plans and specs go under `docs/superpowers/plans` and `docs/superpowers/specs`.

## Proposed or open process items

- #108: visual inspection with screenshots required for UI-affecting PRs.
- #184: automatically audit team PRs and file rated issues.

## How to apply

Before touching a subsystem, search its closed issues for audit findings. When fixing a review item, reference the finding issue, add a regression test that fails without the fix, and verify against a real database where the claim involves SQL.
