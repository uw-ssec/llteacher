---
type: Requirement
title: "Stakeholder requirement: tutoring grounded in each course's own materials, per assignment"
description: "PIs want the tutor grounded in their uploaded course materials (lectures, slides, notes, exams) rather than generic answers, with different materials per assignment, plus agentic fetch of allowlisted external sources."
tags: [stakeholder, rag, knowledge, materials]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/server/knowledge"]
sources:
  - resource: "PR #445"
  - resource: "PR #459"
  - resource: "issue #44"
  - resource: "issue #79"
  - resource: "milestone M7"
---

## Stated needs

- **Grounding in the course's own material** (transcripts 2026-06-02 and 2026-07-28). The economics PI in particular was frustrated that general chatbots answer generically instead of in the course's own framing. RAG was expected to be needed by every project eventually.
- **Agentic fetch:** pull in external materials beyond uploads. Captured as #79 ("agentic fetch of instructor-allowlisted external materials", must-complete).
- **Per-assignment selection** (teacher conversations cited in PR #445): one professor wants certain materials on certain assignments while another wants entirely different knowledge. A single per-course grounding toggle (the original #42/#44 invariant) cannot express this.
- **Citations** so students and instructors can see what the tutor relied on (#41).

## Delivered so far

- PR #445: the OKF knowledge model, with collections attachable at course, homework, section or LLM-config scope and resolution rules.
- PR #459: a filesystem-authoritative OKF bundle with BM25 search exposed to the tutor as tools with citations, plus an instructor knowledge console.
- PR #461: durable S3 persistence.

## Still open

M7 issues #40–#44 (upload and ingestion, retrieval with persisted citations, materials UI, a retrieval quality harness with a regression baseline) and #79. They should be re-scoped against the OKF design (see facts/okf-knowledge-base-design-history). The 2026-07-28 meeting also asked to **base quizzes on uploaded assignments and materials**. That is related but tracked under analytics and adaptive quizzes (#76).
