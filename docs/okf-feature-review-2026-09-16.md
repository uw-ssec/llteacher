# OKF feature review and runtime verification

Reviewed the feature from `f3cd231` through the working tree. Changes remain uncommitted.

## Corrections

- Use the Node API from both development SPAs; explicitly select the TypeScript Vite configuration so stale generated JavaScript cannot select the retired Worker adapter.
- Preserve WebR isolation headers in development and on Node-served static pages and SPA fallback routes.
- Write large concept bodies atomically without passing their contents through process arguments; restore the original body on failed updates.
- Serialize extraction and deletion per material, recover interrupted processing before accepting requests, and adopt an already-written concept on extraction retry.
- Preserve Markdown title/type/description as metadata, remove imported frontmatter from the body, and normalize metadata delimiters rejected by OKF 0.3.0.
- Stop polling unsupported scans that await manual work; update editor and sidebar wording.
- Remove the searchable concept before deleting its material record. A concept-removal failure now returns 503 and retains the record for retry.
- Make two asynchronous UI tests wait for the behavior they assert.

## Real document results

All work used an isolated local Postgres database, MinIO bucket, and knowledge directory; the remote development database was not migrated.

| Fixture | Results |
| --- | --- |
| `Downloads/econ201-okf/knowledge` | 533 Markdown uploads ready after fixing metadata import and retrying failures |
| `Downloads/Ali(Econ 201)` | 528 files selected through Chrome folder upload; 515 accepted, 513 ready, 2 pending scans |
| Rejected original files | 5 MP3, 5 extensionless files, and 3 PDFs exceeding 25 MB |
| Pending original files | `Textbook Scans/Acem.pdf` and `Textbook Scans/Ch12_HO.pdf`, with explicit no-text-layer explanations |

Chrome computer-use checks verified folder upload, visible ready statuses, GDP search returning real PowerPoint/Word/transcript content, readable converted slides, editing and saving a unique marker, finding the marker in search, and reopening the persisted edit. The original text was restored afterward.

A local student fixture used the live configured `gpt-5.4-mini` gateway model. The tutor answered a question from the uploaded `GDP_Deflator` slides, gave the correct formula and scope, and displayed Sources (1). Reloading retained the answer and citation. This was one live grounding question, not the ten-question release evaluation.

A disposable material was uploaded and deleted through the running API after the final deletion fix: DELETE returned 204, the document returned 404, and its database row was absent. The local review membership was restored to instructor afterward.

## Automated validation

- Web: 2,073 tests passed; six optional S3 integration tests skipped. Database integration tests ran against a separate local checks database.
- Admin: 298 tests passed.
- Shared UI: 300 tests passed.
- Both production builds and all three package typechecks passed.
- Final deletion regression suite: 24 tests passed after the last backend change.
- `git diff --check` passed.
- Pinned OKF 0.3.0 validated the real combined bundle: 1,046 concepts, `is_conformant: true`, zero errors and warnings.

## Limits and remaining release checks

The feature does not perform OCR or audio transcription and retains its 25 MB upload limit. Normalizing imported filenames does not rewrite their original internal Markdown links: validation reported 1,394 broken links. The app's links panel is designed to expose broken links, but this is not a lossless import of an existing bundle's relationships.

The stricter OKF publication gate reported `gate_passed: false`: all 1,046 concepts use the feature's existing `status: generated` convention, whereas the gate accepts draft/stable/deprecated. This does not fail format conformance but should be resolved before requiring that publication gate.

The full ten-question grounding evaluation, a second-course live browser isolation test, and optional S3 integration suite were not completed. Automated route/service tests cover authorization and course isolation; the actual upload path exercised local S3 storage extensively.
