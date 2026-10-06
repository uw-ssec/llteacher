---
type: Requirement
title: "Only one process may ever write a course's knowledge bundle or run material extraction"
description: "Exactly one app process writes each course's OKF working copy and S3 manifest and runs extraction; no concurrent tasks, rolling overlap, local processes or recovery commands against the same course."
tags: [knowledge, concurrency, infra, single-writer]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: constraint
code_refs: ["infra/src/app.ts", "infra/src/resources.test.ts", "apps/web/src/server/knowledge/writeLock.ts", "apps/web/src/server/knowledge/persistent-service.ts", "apps/web/src/server/knowledge/materialLock.ts", "docs/knowledge-recovery.md"]
sources:
  - resource: "docs/knowledge-recovery.md"
  - resource: "docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md"
  - resource: "docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md"
  - resource: "infra/README.md"
---

## The requirement
`docs/knowledge-recovery.md`: "Production uses one application writer. Do not run concurrent ECS tasks, local processes, recovery commands, or rolling replacements against the same course."

## Why it holds today
- The ECS service has desired count 1, minimum healthy 0%, and maximum 100%. `resources.test.ts` locks these together.
- Within the process, `writeLock.ts` holds a per-course `O_EXCL` lock file around create, update, relate, remove, and rename. `materialLock.ts` serializes extraction and deletion per material. Reads take no lock.
- The S3 manifest change detector reuses blob hashes based on local inode, device, size, and ns mtime/ctime. That is correct only with one private local cache and one writer, and is "not a distributed filesystem change detector".
- The OKF spec relied on "one instructor per course this quarter" as a real property of the deployment.

## What breaks if violated
Two writers could publish manifests that drop each other's changes. They could interleave okf's `index.md`/`log.md` regeneration, or double-run extraction. Nothing at the S3 layer detects this. There are no conditional writes or version checks across tasks (inferred from the docs; not code-audited).

## Changing it
Scaling out needs: cross-task locking for knowledge mutations (for example a Postgres advisory lock or a DB-backed lease), a queue for extraction (SQS was named first), and a change detector that does not rely on local inode state. The overdue sweep is already safe across processes through its advisory lock. Update this requirement, the ECS settings, and their test together.
