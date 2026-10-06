---
type: Decision
title: "Each course's knowledge base is an OKF bundle on the filesystem, served by the pinned okf binary"
description: "The 09-15 spec replaced the 09-09 Postgres-stored OKF bundle and collections: one OKF v0.2 bundle per course on disk, maintained by okf 0.3.0 via execFile, searched with BM25 through two read-only chat tools."
tags: [knowledge, rag, okf, product-feature]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/knowledge/service.ts, apps/web/src/server/knowledge/okfCli.ts, apps/web/src/server/knowledge/conceptId.ts, apps/web/src/server/knowledge/writeLock.ts, apps/web/src/server/routes/chat.ts, apps/web/src/server/routes/knowledgeDocuments.ts, apps/web/src/db/migrations/0052_okf_bundle_knowledge_base.sql, Dockerfile.aws]
sources:
  - resource: docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md
  - resource: docs/superpowers/specs/2026-09-09-knowledge-management-design.md
  - resource: docs/superpowers/plans/2026-09-15-okf-bundle-knowledge-base.md
  - resource: docs/rag-implementation-decisions.md
  - resource: docs/okf-feature-review-2026-09-16.md
  - resource: "PR #459"
---

This is the **product's** course-knowledge feature (milestone M7, epic #44). It is separate from this project-memory bundle.

## Spec proposed
- **2026-09-09:** the bundle was stored in Postgres (`knowledge_documents` keyed by path, a `knowledge_links` graph). Named **collections** attached to course, homework, section, or LLM config, resolving most-specific-wins, and pgvector chunks were planned. This was implemented in PRs #445/#446 and the console.
- **2026-09-15:** this superseded the 09-09 knowledge layer. Constraints were two weeks to live classes, real folders made mostly of docx/pptx, and one instructor per course. The new design: **one OKF bundle per course at `${KNOWLEDGE_ROOT}/courses/{courseId}/knowledge/`**, authoritative on disk and served by the `okf` binary. Students get two read-only tools. Search is okf's BM25 only, with no collections or embeddings this quarter.

## Implemented (PR #459)
- `KnowledgeService` (`server/knowledge/service.ts`) is the only code that touches the bundle.
  - It derives the path from a UUID-validated course id.
  - It validates concept ids against the OKF alphabet.
  - It runs `okf` via `execFile` with an argument array and `--json`, a 10 s timeout, and output caps.
  - It implements delete and rename itself, since okf has neither.
  - It holds a per-course `O_EXCL` write lock.
- `Dockerfile.aws` installs checksum-checked okf **0.3.0**.
- `chat.ts` exposes `searchKnowledge` and `showKnowledge`, and records opened concepts as `citations` (migration 0052: nullable `material_chunk_id`, plus `concept_path`/`course_id` with a one-source CHECK). Replies render a Sources list.
- **Divergences:** storage is S3-snapshot-backed, not EFS (see `decisions/knowledge-persistence-s3-manifest`). Scanned PDFs get OCR rather than staying pending (see `decisions/in-process-extraction-and-ocr`). Search accepts a `dir` scope (09-17 search-first redesign).

## Rejected alternatives
- Keeping the Postgres bundle with Postgres full-text search.
- Postgres as authority mirrored to disk.
- S3 as the bundle store.
- Collections now (the tables stay unused).
- Hybrid lexical plus pgvector.
- An MCP stdio client (can be swapped in later).

## Consequences
- The bundle tables, `material_chunks`, and the collection code stay in the tree, unused.
- Bumping the okf pin needs the CI fixture test.
- Validation found 1,394 broken links on import, and the `status: generated` convention fails okf's stricter publication gate.

# Related Concepts
- [Course knowledge base as built (OKF bundle, not vector RAG)](../architecture/knowledge-base-okf.md): The knowledge base as built
- [Knowledge base: from pgvector RAG plan to filesystem-authoritative OKF bundle](../facts/okf-knowledge-base-design-history.md): From pgvector RAG to OKF bundles
- [Knowledge bundles persist to S3 as content-addressed blobs plus a manifest, not on EFS](knowledge-persistence-s3-manifest.md): How bundles persist
- [Only one process may ever write a course's knowledge bundle or run material extraction](../requirements/single-writer-knowledge-and-extraction.md): One writer per bundle
- [Students get read-only knowledge tools, scoped to their own course, and material is treated as untrusted](../requirements/student-knowledge-access-read-only.md): Student tools are read-only
- [Stakeholder requirement: tutoring grounded in each course's own materials, per assignment](../requirements/stakeholder-course-grounded-tutoring.md): The stakeholder need it serves
- [okf binary must be v0.3.0; KNOWLEDGE_ROOT cannot be a symlink](../facts/code-okf-binary-pin.md): The product's okf binary pin
