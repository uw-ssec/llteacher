---
type: Decision
title: "Course-material storage moved from planned R2 to Neon Object Storage to AWS S3, behind one interface"
description: "Uploaded originals sit behind a narrow ObjectStore (put/get/delete/head) keyed courses/{courseId}/materials/{materialId}/{filename}; backend went R2 (spec) -> Neon Object Storage (09-09) -> S3 with ECS task-role creds."
tags: [storage, s3, materials, infra]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: context
code_refs: ["apps/web/src/server/storage/objectStore.ts", "apps/web/src/server/routes/materials.ts", "apps/web/src/server/repositories/materials.ts", "infra/src/database.ts"]
sources:
  - resource: "docs/superpowers/specs/2026-09-09-knowledge-management-design.md"
  - resource: "docs/superpowers/plans/2026-09-09-knowledge-management.md"
  - resource: "docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md"
  - resource: "commit b511820"
  - resource: "commit 3f46923"
  - resource: "commit d249368"
---

## Spec proposed
The 2026-09-09 knowledge spec added a Cloudflare **R2** bucket (`MATERIALS`) behind a narrow `ObjectStore` interface. It noted that R2 is S3-compatible and that "AWS + Pulumi (#81) is the settled target platform, so that migration swaps one implementation rather than every caller". Upload was a direct multipart POST capped at **25 MB**, with an extension and MIME allowlist (`pdf, docx, pptx, txt, md, vtt, srt`). The key layout was `courses/{courseId}/materials/{materialId}/{filename}`.

## Implemented
- The same day, the plan switched the backend to **Neon Object Storage** (commit `b511820`). It speaks the S3 wire protocol and its buckets are branch-aware (copy-on-write with database branches). `StorageError` still mentions Neon's 503 SlowDown.
- With the AWS move, `objectStore.ts` uses `@aws-sdk/client-s3` and the default refreshing credential chain (commit `d249368`). In production that is the ECS task role, with no static keys. Explicit endpoint credentials are for local emulators (MinIO, Floci) only.
- Infra provisions one private, encrypted, versioned bucket with a noncurrent-version lifecycle and Pulumi protection in production. The same bucket also holds knowledge snapshots.
- The 25 MB cap and the allowlist are still enforced (`MAX_UPLOAD_BYTES` in `routes/materials.ts`).
- The import-pipeline spec's presigned direct upload for larger files was **not** implemented. The OKF review lists 3 PDFs over 25 MB and 5 MP3s as rejected.

## Why
A narrow interface let the backend change twice without touching callers. The course-prefixed keys make course deletion a prefix sweep and make cross-tenant access visible in logs.

## Rejected alternatives
- R2 (no branch-aware buckets; Cloudflare is leaving anyway).
- Presigned uploads for now.
- A separate static-assets or export bucket (deferred, #91).

## Consequences
Large scans and audio cannot be uploaded until presigned upload exists.
