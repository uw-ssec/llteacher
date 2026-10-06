---
type: Decision
title: "Knowledge bundles persist to S3 as content-addressed blobs plus a manifest, not on EFS"
description: "The OKF spec required an EFS mount; implementation instead keeps a temporary local working copy restored from S3 (courses/{id}/knowledge/manifest.json + blobs/{sha256}), publishing the manifest last."
tags: [knowledge, storage, s3, durability]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/server/knowledge/persistent-service.ts, apps/web/src/server/knowledge/persistence-format.ts, apps/web/src/server/knowledge/recovery.ts, apps/web/src/server/storage/objectStore.ts, docs/knowledge-recovery.md, infra/src/app.ts]
sources:
  - resource: docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: docs/superpowers/plans/2026-09-21-pr461-review-disposition.md
  - resource: docs/knowledge-recovery.md
  - resource: commit bfd0954
  - resource: commit a7b17b3
  - resource: "PR #461"
---

## Spec proposed
The OKF knowledge spec (2026-09-15) added **EFS** to #81: a POSIX filesystem with an access point at `/mnt/knowledge`, automatic backups, and a nightly tar as a follow-up. It rejected "S3 as the bundle store with a local cache" as a cache-coherence problem.

## Implemented
The minimal-production design (2026-09-21) reversed that to avoid EFS, its mount targets, and its security group. Instead:
- OKF runs on a **temporary local working copy** restored on first use from the existing materials bucket.
- The first version uploaded whole-course ZIPs on every mutation (commit `bfd0954`). The PR #461 review replaced that with **content-addressed immutable blobs** (`courses/<uuid>/knowledge/blobs/<sha256>`) and a `manifest.json` **published last** (commit `a7b17b3`).
- A mutation succeeds only after the manifest is stored. Failed writes restore the last durable state.
- Unchanged files reuse hashes keyed on inode, device, size, and ns mtime/ctime, which relies on the single writer.
- Legacy `snapshot.zip` files are decoded in a worker with expansion, path, symlink, and CRC checks, migrated on the next write, and retained.
- Corruption fails closed with fixed codes (`KNOWLEDGE_CORRUPT_MANIFEST|BLOB|LEGACY`) and diagnostics that leave out content.
- A non-empty local course with no remote snapshot is **refused**, never uploaded or deleted.
- `objectStore.ts` tells a missing object apart from a 403 using a bounded exact-prefix listing.

## Why
It reuses one bucket with no extra service. Versioning gives recovery.

## Rejected alternatives
- EFS.
- Postgres as the bundle store.
- Whole-course ZIP per mutation (the first version).

## Consequences
- Requires the single-task, stop-before-start deployment (see `decisions/single-task-full-app-service`).
- Metadata scans and retained history grow storage.
- Recovery of a selected S3 version is a manual operator procedure with a temporary prefix-scoped role (`docs/knowledge-recovery.md`). The app role has no version-read permission.
- The task role's S3 access is limited to `courses/*/materials/*` and `courses/*/knowledge/*`. It is shared by all courses and is **not** per-tenant IAM isolation.

# Related Concepts
- [Course-material storage moved from planned R2 to Neon Object Storage to AWS S3, behind one interface](materials-object-storage-evolution.md): Same object-storage interface
