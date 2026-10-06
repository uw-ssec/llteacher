---
type: Fact
title: "Knowledge base: from pgvector RAG plan to filesystem-authoritative OKF bundle"
description: "Course knowledge moved from a planned pgvector chunk/embedding RAG to an OKF v0.2 bundle on disk served by the pinned okf binary with BM25 search, persisted to S3 as content-addressed blobs with manifest-last publication."
tags: [knowledge, rag, okf, architecture, s3]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:31Z" }
status: stable
governance: context
code_refs: ["apps/web/src/server/knowledge", "apps/web/src/server/knowledge/persistent-service.ts", "apps/web/src/server/knowledge/okfCli.ts", "apps/web/scripts/recover-knowledge.ts", "docs/knowledge-recovery.md", "docs/rag-implementation-decisions.md"]
sources:
  - resource: "PR #445"
  - resource: "PR #459"
  - resource: "PR #461"
  - resource: "issue #42"
  - resource: "issue #44"
  - resource: "milestone M7"
---

## Evolution

1. **M7 plan (2026-07-30):** upload, chunk and embed into `material_chunks` with pgvector, then retrieval, grounding and persisted citations (#40–#44). Those issues are still open.
2. **PR #445 (2026-09-09):** a course's knowledge is an OKF v0.2 bundle, a markdown tree where **path is identity**. Collections are named selections that can be attached to a course, homework, section or LLM config. This came from teacher conversations: one professor wants particular materials on particular assignments and another wants different knowledge entirely, which a per-course boolean cannot express. It answered #44's open question 4. Broken links are stored, not dropped, because OKF says consumers must tolerate them.
3. **PR #459 (2026-09-18):** the bundle on a shared filesystem became **authoritative**, served by the pinned `okf` 0.3.0 binary (checksum-verified, invoked via `execFile` only). Retrieval is the bundle's own **BM25 search**, exposed to the tutor as chat tools with citations. Postgres no longer stores bundle content or embeddings. The old tables were left in place, not dropped. This move is what forced the app off Workers.
4. **PR #461:** durable S3 snapshots for ECS.

## Lessons from the PR #461 review (verdict HOLD, then fixed)

- Synchronous `zipSync`/`unzipSync` of the **whole course on every mutation** blocked Node's single event loop on a 0.5-vCPU task. Any authenticated user could cause an app-wide stall. Fix: **changed-file content-addressed blobs** with **manifest-last** publication. Legacy ZIP decode moved to a worker with path, expansion, symlink and CRC defenses.
- A corrupted snapshot read outside the rollback try/catch bricked the course permanently. Fix: structured corruption diagnostics and explicit, validated S3-version recovery (`recover-knowledge.ts`), with no automatic delete or reseed.
- The task-role S3 policy was bucket-wide. It is now narrowed to the course-material and knowledge prefixes. Missing-object 403s under scoped list permissions are handled, and real permission errors fail closed.

## Implication

The M7 issues need re-scoping against this design (inferred). Do not build pgvector chunking without checking the specs in `docs/superpowers/specs` (2026-09-15 OKF bundle design supersedes 2026-09-09 sections).
