---
type: Decision
title: "Course-material extraction runs in-process with deterministic extractors, plus OCR for scanned PDFs"
description: "Uploads return 201 then extract in-process: deterministic text/SRT-sniffing, docx, pptx and PDF-text extractors write OKF concepts; scanned PDFs fall back to vision OCR via LLMoxie (spec said leave them pending). No SQS."
tags: [knowledge, extraction, materials, reliability]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: context
code_refs: [apps/web/src/server/knowledge/extract/index.ts, apps/web/src/server/knowledge/extract/job.ts, apps/web/src/server/knowledge/extract/ocr.ts, apps/web/src/server/knowledge/extract/pdf.ts, apps/web/src/server/knowledge/extract/docx.ts, apps/web/src/server/knowledge/extract/pptx.ts, apps/web/src/server/knowledge/cleanup.ts, apps/web/src/server/knowledge/materialLock.ts]
sources:
  - resource: docs/superpowers/specs/2026-09-15-okf-bundle-knowledge-base-design.md
  - resource: docs/superpowers/specs/2026-09-09-knowledge-import-pipeline-design.md
  - resource: docs/superpowers/specs/2026-09-21-minimal-production-infrastructure-design.md
  - resource: docs/okf-feature-review-2026-09-16.md
  - resource: docs/ocr-validation-2026-09-17.md
  - resource: commit 9cd02a1
  - resource: commit fe164fb
---

## Spec proposed
- **2026-09-09 knowledge spec:** tiered and honest. Text-native formats convert. Binaries sit at `pending` with "extraction not yet implemented (#40)". Hand-authored concepts are allowed.
- **2026-09-09 import-pipeline spec:** surveyed a real Econ 201 folder (529 files, 408 docx/pptx, SRT captions saved as `.txt`, scanned PDFs, mp3s). It required content sniffing and slugified paths.
- **2026-09-15 OKF spec:** deterministic pure-JS extractors (docx via unzip, pptx slide order, PDF text layer). Scanned PDFs, audio, and images stay `pending` "not this quarter".
- **2026-09-21 infra design:** extraction stays on the existing **in-process queue**. A restart can lose pending work, so the UI must expose `pending`/`failed` and allow retry. SQS is the first reliability addition if needed.

## Implemented
- `extract/` has `text.ts` (sniffs SRT/VTT by content), `docx.ts`, `pptx.ts`, and `pdf.ts` (using `fflate` and `unpdf`), with bounded decompression (commits `9cd02a1`, `d9aeebe`).
- `job.ts` runs the lifecycle `pending → processing → ready|failed`. It writes `course_materials.document_path` and `relative_path`, and reingest updates the existing concept or creates one.
- Extraction and deletion are serialized per material (`materialLock.ts`). Interrupted processing is recovered at startup.
- **Divergence:** commit `fe164fb` (2026-09-17) added `ocr.ts`, a vision-OCR fallback through the LLMoxie gateway for PDFs with no text layer. PDF retry is queued with a 202. `cleanup.ts` proposes a remark-normalised Markdown cleanup diff, and the pre-edit body is preserved under `originals/`.
- Audio and images are still unsupported.

## Why
Students and instructors needed real course folders searchable within two weeks. Node has no per-request CPU cap once the response is sent.

## Rejected alternatives
- SQS or a worker service.
- Model-based extraction for every format.
- Presigned uploads.

## Consequences
- Work in flight is lost if the task is replaced. It is visible and retryable.
- OCR sends scanned course content to the LLM gateway, which is a data-flow point to cover in the FERPA review (inferred).

# Related Concepts
- [Each course's knowledge base is an OKF bundle on the filesystem, served by the pinned okf binary](okf-bundle-knowledge-base.md): Extraction feeds the bundle
- [Only one process may ever write a course's knowledge bundle or run material extraction](../requirements/single-writer-knowledge-and-extraction.md): Extraction is single-writer too
