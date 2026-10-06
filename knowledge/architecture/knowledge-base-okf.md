---
type: Architecture
title: "Course knowledge base as built (OKF bundle, not vector RAG)"
description: "Course knowledge is an OKF markdown bundle per course under KNOWLEDGE_ROOT, searched by the pinned okf v0.3.0 CLI and snapshotted to S3; the tutor reads it via searchKnowledge/showKnowledge tools. pgvector material_chunks is unused."
tags: [architecture, knowledge, okf, rag, s3]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: context
code_refs: ["apps/web/src/server/knowledge", "apps/web/src/server/knowledge/okfCli.ts", "apps/web/src/server/knowledge/service.ts", "apps/web/src/server/knowledge/persistent-service.ts", "apps/web/src/server/knowledge/extract", "apps/web/src/server/routes/knowledgeDocuments.ts", "apps/web/src/server/routes/materials.ts", "apps/web/src/server/storage", "apps/web/scripts/recover-knowledge.ts"]
sources:
  - resource: "apps/web/README.md"
  - resource: "apps/web/src/server/index.ts"
  - resource: "apps/web/src/db/schema/runtime.ts"
  - resource: "docs/okf-feature-review-2026-09-16.md"
  - resource: "8f9153f"
  - resource: "32bea7f"
---

**What it is.** Each course has an OKF bundle (markdown concepts with frontmatter, `index.md`, `log.md`) at `KNOWLEDGE_ROOT/courses/<courseId>/`. All bundle reads/writes go through `OkfKnowledgeService` (server/knowledge/service.ts), which shells out to the `okf` binary via `runOkf` (argument arrays, never a shell string, `--json`, 10s default timeout, 4 MiB stdout cap). Search is okf's own search; there is no path filter, so directory-scoped search over-fetches 200 and trims. Writes are serialized by a per-course write lock and per-material lock.

**Durability.** With `STORAGE_BUCKET` set, `PersistentKnowledgeService` snapshots each course bundle (plus pre-edit originals) to S3 under `courses/<id>/knowledge/*`; `KNOWLEDGE_ROOT` is just a temporary working copy restored on first use. No EFS. A nonempty local course without a remote snapshot is refused rather than overwritten. Recovery tooling: `apps/web/scripts/recover-knowledge.ts`, `docs/knowledge-recovery.md`.

**Ingestion.** Instructors upload materials (`routes/materials.ts`) to S3; an in-process extraction queue converts them to concepts (text-layer PDFs directly; scanned PDFs via poppler page renders + `OCR_MODEL` through LLMoxie, max 64 pages). Interrupted `processing` materials are marked `failed` at startup and are retryable. Single-writer only: overlapping replicas are unsupported.

**Tutor use.** `chatHandler` lists the course's concepts into a `<course_knowledge>` block (capped at `KNOWLEDGE_LISTING_MAX_CHARS` = 6000) and exposes `searchKnowledge`/`showKnowledge` tools, gated by `llm_configs.knowledge_enabled` plus a per-course instruction. Opened concepts are recorded in `citations.concept_path`. If the bundle fails to load, the tools are removed for that turn.

**Not built / dormant:** `material_chunks.embedding vector(1536)` and `citations.material_chunk_id` remain for "the day embeddings return"; nothing writes embeddings. Collections routes (`routes/knowledgeCollections.ts`) exist but are intentionally unregistered in server/index.ts.

**Local setup gotchas:** okf must be v0.3.0 (CI and image pin it); `KNOWLEDGE_ROOT` must not be a symlink (macOS `/tmp` fails); see facts/code-okf-binary-pin.
