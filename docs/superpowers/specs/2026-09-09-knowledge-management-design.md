# Knowledge management: OKF bundles, collections, and per-assignment grounding (#42)

Status: approved 2026-09-09
Issue: [#42](https://github.com/uw-ssec/llteacher/issues/42) — supersedes its per-course grounding toggle
Epic: [#44](https://github.com/uw-ssec/llteacher/issues/44) — resolves open design question 4
Coordinates with: #40 (ingestion pipeline, not built), #41 (retrieval + citations, not built), #81 (Pulumi AWS baseline, not built), #92 (course duplication, not built)

## Problem

Instructors need to ground the tutor in their own course materials — PDFs, slide
decks, lecture transcripts, syllabi. Two facts about the current state:

1. **The schema is half-built and the code is empty.** `course_materials` and
   `material_chunks` (pgvector, 1536-dim) exist in
   `apps/web/src/db/schema/content.ts`. There is no `status` column, no object
   storage binding in `apps/web/wrangler.jsonc`, no upload route, and no UI.
   `apps/web/src/server/repositories/materials.ts` is a single
   `listMaterialsForCourse` stub.

2. **The specced design does not match what instructors asked for.** Issue #42
   describes a flat per-course material list with a single per-course grounding
   toggle, and epic #44 pins "grounding toggle is per-course" as a cross-cutting
   invariant. Teacher conversations produced a different requirement: one
   professor wants certain materials available to certain assignments, while a
   different professor wants different knowledge entirely. A single per-course
   boolean cannot express that.

Epic #44 lists this exact question as unresolved design decision 4: *"Grounding
toggle placement: per-course boolean is simple. Did you consider per-homework or
per-section granularity? Why not?"* This spec answers it.

There is also a structural requirement that a flat material list cannot carry.
The knowledge base is not a bag of files — it is a browsable structure whose
documents reference each other, and those references are meant to be traversed.
That is what [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format)
specifies, and adopting the format is cheaper than inventing a private one.

## Decision

**A course's knowledge base is an OKF v0.2 bundle. Collections are named
selections over that bundle. Collections attach to a course, homework, section,
or LLM config, and resolve most-specific-wins.**

Rejected alternatives:

- **Flat library, collections as tags.** Fewest concepts, one join table, no
  recursion. Rejected because it discards the traversable structure — documents
  that reference each other are the point, and a tag set has no paths to link
  between.
- **Collections *are* the folders** (a document lives in exactly one). Simplest
  mental model. Rejected because a shared reading used by two assignments would
  have to be uploaded twice.
- **Additive resolution** (union of every attached level). Attaching never
  silently removes knowledge. Rejected in favour of override to keep one
  layering model across the console — `prompt_templates` already resolves
  most-specific-wins, and two different inheritance rules on two adjacent
  instructor-facing features is a support burden. Revisit if instructors report
  the surprise case (attaching to a section silently drops course readings).
- **Org-scoped or owner-scoped material library.** Enables cross-course reuse and
  a departmental knowledge base. Rejected for now: `course_materials.course_id`
  already exists, course-scoping needs no migration of the existing FK, and the
  tenancy story stays trivial. Term rollover is #92's job, not this feature's.

## What OKF actually specifies

Load-bearing facts from the [v0.2
spec](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md),
because the data model below is shaped by them:

- A **bundle** is "a directory tree of markdown files."
- A **concept** is one `.md` file. Its ID is "the path of the concept's file
  within the bundle, with the `.md` suffix removed" — `stats/regression.md` has
  ID `stats/regression`. **Paths are identity.**
- Frontmatter: `type` is "the only always-required key; a concept carrying just
  `type` is fully conformant." Recommended: `title`, `description`, `resource`
  ("a URI that uniquely identifies the underlying asset"), `tags`.
- Concepts link to each other with **standard markdown links**, either
  bundle-absolute (leading `/`) or relative. "The specific kind (parent/child,
  references, joins-with, depends-on) is conveyed by the surrounding prose, not
  by the link itself." Consumers **"MUST tolerate broken links."**
- `index.md` and `log.md` are **reserved filenames** that "MUST NOT be used for
  concept documents." `index.md` is a directory listing of
  `* [Title](url) - description` entries under headings; `log.md` is
  date-grouped update history, newest first, ISO 8601 headings. Only the
  bundle-root `index.md` carries `okf_version`.

Two consequences worth stating up front. First, an uploaded file and an OKF
concept are **not the same row**: a 200-page PDF may yield several concepts, and
an instructor may author a concept with no upload behind it at all. Second,
directories are implicit in paths — so **creating a folder creates its
`index.md`**, which is both format-faithful and the reason an empty folder
survives a page reload.

## Data model

All tables live in `apps/web/src/db/schema/content.ts`. Every table carries
`course_id` and cascades from `courses`, matching the existing content tables.

### `course_materials` (extend existing)

The uploaded artifact, and only that. New columns:

| Column | Type | Notes |
|---|---|---|
| `storage_key` | text | Object-store key; see Storage below |
| `byte_size` | integer | |
| `content_type` | text | Validated mime |
| `checksum` | text | SHA-256; makes re-ingest idempotent per #44's invariant |
| `status` | `material_status` enum | `pending \| processing \| ready \| failed` |
| `error_detail` | text, nullable | Populated on `failed` |

`source_type` (`pdf | slides | transcript | syllabus | other`), `title`,
`original_filename`, `upload_metadata`, and `uploaded_by_id` already exist and
are unchanged.

### `knowledge_documents` (new)

One row per `.md` file in the bundle.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `course_id` | uuid → `courses` cascade | |
| `path` | text | OKF concept ID — the file path **without** the `.md` suffix (`stats/regression`). Directory listings are `<dir>/index`; the bundle log is `log` |
| `kind` | `knowledge_document_kind` enum | `concept \| index \| log` |
| `index_status` | `knowledge_index_status` enum | `pending \| indexed \| failed`. The chunking lifecycle; see Two lifecycles below |
| `type` | text | The required OKF frontmatter field. Null only when `kind <> 'concept'` |
| `title` | text, nullable | |
| `description` | text, nullable | |
| `tags` | jsonb, nullable | YAML list |
| `frontmatter` | jsonb, nullable | Non-reserved keys, preserved verbatim |
| `body` | text | Markdown below the frontmatter |
| `body_original` | text, nullable | Extractor output, so "revert to extraction" works |
| `source_material_id` | uuid → `course_materials` set null, nullable | |
| `edited_by_id` | uuid → `course_memberships` set null, nullable | |
| `edited_at`, `created_at`, `updated_at` | timestamptz | |

Constraints:

- `UNIQUE (course_id, path)` — paths are identity.
- CHECK: a `concept` row's path basename is neither `index` nor `log` (the spec
  forbids it); an `index`/`log` row's basename is exactly that.
- CHECK: `kind = 'concept'` implies `type IS NOT NULL`.
- Index on `(course_id, path text_pattern_ops)` for prefix queries — subtree
  selection and directory listing are both `path LIKE 'dir/%'`.

### `material_chunks` (repoint existing)

The chunkable unit is the **document**, not the upload: one PDF may yield several
concepts, and a hand-authored concept has no upload at all. `material_chunks`
currently references `course_materials.id`, which cannot express either case. PR
1 repoints it to `knowledge_documents.id` (renaming `material_id` →
`document_id`). This is free right now — no ingestion pipeline exists, so the
table is empty — and doing it here stops #40 from building on the wrong FK.

### Two lifecycles, deliberately separate

| | Lives on | Values | Meaning |
|---|---|---|---|
| Extraction | `course_materials.status` | `pending / processing / ready / failed` | Has this upload been turned into documents? |
| Indexing | `knowledge_documents.index_status` | `pending / indexed / failed` | Has this document been chunked and embedded? |

They are not the same question and a hand-authored document only has the second
one. The collection picker's "not yet ready" count means `index_status <>
'indexed'`.

### `knowledge_links` (new)

The traversable graph. Rebuilt from `body` on every save.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `source_document_id` | uuid → `knowledge_documents` cascade | |
| `raw_href` | text | As written, before resolution |
| `resolved_document_id` | uuid → `knowledge_documents` cascade, nullable | Null when broken |
| `is_broken` | boolean | Derived, stored for cheap filtering |

Backlinks are a query on `resolved_document_id`; no second table. Broken links
are stored rather than dropped: the spec says consumers must tolerate them, and
an instructor should be able to *see* them, which requires keeping them.

### `material_collections` (new)

`id`, `course_id` (cascade), `name`, `description` (nullable),
`created_by_id` → `course_memberships` restrict, timestamps.
`UNIQUE (course_id, name)`.

### `collection_items` (new)

`id`, `collection_id` (cascade), and exactly one of:

- `document_id` → `knowledge_documents` cascade — a single file, or
- `directory_path` text — a subtree, resolved **live** (`path LIKE
  directory_path || '/%'`), so files added to that folder later join the
  collection automatically. This is what "select the folders that make up a
  collection" means.

CHECK `num_nonnulls(document_id, directory_path) = 1`, following the
`prompt_templates_exactly_one_scope_chk` pattern already in this schema. Partial
unique indexes on `(collection_id, document_id)` and
`(collection_id, directory_path)`.

### `collection_attachments` (new)

Deliberately mirrors `prompt_templates`' scope shape so resolution code reads
like `apps/web/src/lib/prompts.ts`:

`id`, `collection_id` (cascade), `course_id`, and nullable `scope_course_id` /
`scope_homework_id` / `scope_section_id` / `scope_llm_config_id`, with
`CHECK num_nonnulls(scope_course_id, scope_homework_id, scope_section_id,
scope_llm_config_id) = 1` and an index per scope column.

`course_id` and `scope_course_id` are different fields doing different jobs and
both are needed: `course_id` is the denormalized tenancy guard present on *every*
row, so a listing can filter by course without joining through four possible
scope targets; `scope_course_id` is set on exactly those rows whose attachment
target *is* the course itself, and is null on homework-, section-, and
config-scoped rows.

Multiple *distinct* collections may attach to one target; the same collection
may not attach twice (unique per `(collection_id, scope_*)`).

## Resolution

```
section → homework → course → llm_config
```

The narrowest level carrying **any** attachment supplies the entire retrieval
corpus; collections attached at that same level combine. The LLM config sits at
the bottom deliberately: a tutor persona's own knowledge is a fallback for when
the course hierarchy says nothing, not an override of an instructor's explicit
per-assignment choice.

This is a pure function over an attachment list — no database access — and lives
in `apps/web/src/server/knowledge/resolveCollections.ts` so it is table-testable
and so retrieval (#41) and the admin console consume the same implementation.

## Storage

No binding exists today. Add an R2 bucket (`MATERIALS`) to
`apps/web/wrangler.jsonc` behind a narrow `ObjectStore` interface
(`put`/`get`/`delete`/`head`) in `apps/web/src/server/storage/`. R2 is
S3-API-compatible and AWS + Pulumi (#81) is the settled target platform, so that
migration swaps one implementation rather than every caller.

Key layout: `courses/{courseId}/materials/{materialId}/{filename}`.
Course-prefixed, so deleting a course is a prefix sweep and cross-tenant access
is structurally visible in logs.

Upload is a direct multipart POST to the Worker — no presign round-trip. Capped
at **25 MB**, with presigned PUT documented as the upgrade if instructors hit the
ceiling. Extension + mime allowlist: `pdf`, `docx`, `pptx`, `txt`, `md`, `vtt`,
`srt`. Validated client-side for a fast error and server-side as the authority.

## Ingestion (stubbed, without lying)

Chunking and embedding belong to #40/#41. This spec ships everything up to the
`ready` line, in three tiers:

1. **Text-native** (`txt`, `md`, `vtt`, `srt`) — genuinely converted now.
   Decoding a WebVTT transcript into an OKF concept with `type: transcript`
   frontmatter is string handling, no model call. Transcripts are a named
   instructor use case, so this path works end to end today.
2. **Binary** (`pdf`, `docx`, `pptx`) — stored, held at `status: pending`, with
   an explicit "extraction pipeline not yet implemented (#40)" note surfaced in
   the UI. It never claims `ready`.
3. **Hand-authoring** — because documents are editable, an instructor can write a
   concept, point its `resource` frontmatter at the uploaded PDF, and it is
   genuinely ready. Zero AI, real value, and it makes tier 2 survivable.

No status ever misrepresents reality, and the live-updating UI has real
transitions to render rather than untested polling code.

**Editing invalidates indexing.** Epic #44's "once `ready`, status does not
revert" invariant is about the *extraction* lifecycle, and it still holds there.
An instructor edit is a new indexing trigger, not a regression: saving a document
body sets that document's `index_status` back to `pending`, leaving the source
material's extraction `status` untouched. Separating the two lifecycles is what
lets both rules be true at once.

**`index.md` and `log.md` are maintained automatically.** Any document create,
rename, move, or delete regenerates the parent directory's `index.md` listing and
appends a dated entry to the bundle's `log.md`. Change history, in-format.

## API

Every route nests under `/api/courses/:courseId/…`, matching the existing
`llm-configs/:configId` convention, so `requireInstructorOf()` guards tenancy
directly from the path with no lookup-then-authorize step. All routes are
instructor-of-course only.

Documents are addressed by **UUID, not path**, for every mutation — paths contain
slashes and do not belong in URL params. `path` remains a data field.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/materials` | List; multipart upload |
| GET/PATCH/DELETE | `/materials/:materialId` | Detail; rename/retype; delete (cascades chunks) |
| POST | `/materials/:materialId/reingest` | Re-run tier-1 conversion, or reset to `pending` |
| GET | `/knowledge/documents` | The bundle tree |
| POST | `/knowledge/documents` | Create concept or folder (folder ⇒ its `index.md`) |
| GET/PUT/DELETE | `/knowledge/documents/:documentId` | Frontmatter + body |
| POST | `/knowledge/documents/:documentId/move` | Rename or reparent; rewrites inbound links |
| GET | `/knowledge/documents/:documentId/links` | Outbound, backlinks, broken |
| GET/POST | `/knowledge/collections` | |
| GET/PATCH/DELETE | `/knowledge/collections/:collectionId` | |
| PUT | `/knowledge/collections/:collectionId/items` | Set membership wholesale |
| GET/POST/DELETE | `/knowledge/collections/:collectionId/attachments` | |
| GET | `/knowledge/resolve?homeworkId=&sectionId=` | The **effective** collection set |

That last endpoint is not a convenience. It makes the override rule visible in
the UI instead of something instructors must reason about, and retrieval (#41)
consumes the same resolution function behind it.

Payload types go in `packages/ui/src/api/types.ts`, the existing contract file
that `apps/web`'s repositories are compile-time checked against.

## UI

`apps/admin`. New sidebar nav key `knowledge` (`authorOnly: true`), placed after
LLM configs. `RecordId`'s prefix union gains `DOC` and `COL`, per the documented
rule in `docs/architecture/admin-console.md` ("add a new prefix to the union when
a new record type warrants it").

1. **`KnowledgeView`** — the bundle browser. Directory-tree rail derived from
   paths; right pane lists the selected directory's documents with `DOC·xxx`
   badge, type, title, description, status, and source-material link. Upload
   dropzone, new folder, new document.
2. **`KnowledgeDocumentView`** — one concept. Frontmatter editor (`type`
   required; title, description, tags), markdown body with preview toggle
   (`react-markdown` + `remark-gfm` are already `apps/admin` dependencies), a
   **Links panel** showing outbound links, backlinks, and broken links flagged
   rather than hidden, plus revert-to-extraction and source download.
3. **`CollectionsView`** — `COL·xxx`, name, resolved counts ("3 folders, 41
   documents"), attachment badges, updated-at.
4. **`CollectionEditView`** — the same tree with checkboxes (a checked folder is
   a live subtree) beside a resolved-files pane showing exactly what is included
   and how many are not yet `ready`.
5. **Attachment from both directions** — an "Attached to" panel on the
   collection, *and* a Knowledge field in `HomeworkForm` / `HomeworkEditView`.
   The second is where instructors will actually look; it shows the resolved
   effective set and warns when a section overrides it.

Status polling reuses `useApiResource`, with an interval active only while some
row is `pending` or `processing` and stopping when none are — not a blanket
timer.

## Targeted improvement to existing code

`repositories/materials.ts` currently does `db.select().from(courseMaterials)` —
a `SELECT *`. Once documents carry full markdown bodies nearby, unbounded
column selection in list queries becomes a real cost. Narrow it to an explicit
column list as part of PR 1. This is in scope because this feature is what makes
it matter; no other refactoring of that module is proposed.

## Testing

- **Repositories** — cross-org and cross-course isolation, following the existing
  `scope.test.ts` / `materials.test.ts` patterns. Two seeded orgs, assert zero
  leakage on every list and read path.
- **Resolution** — table-driven unit tests over the
  `section → homework → course → llm_config` chain, including the empty case and
  multiple collections at one level. Pure function, no database.
- **Routes** — upload validation (size, mime, extension), tenancy (an instructor
  of course A cannot touch course B), path-uniqueness conflicts, and the reserved
  `index`/`log` basename rejection.
- **Link parsing** — absolute and relative hrefs, broken-link tolerance,
  backlink symmetry, and link rewriting on move.
- **Components** — status rendering and upload states per #42's requirement;
  collection-picker resolution counts.

## Sequencing

One spec, three PRs. Each is independently reviewable and PR 1 lands the model
everything else depends on.

1. **Schema + migration + repositories + resolution function.** Includes
   repointing `material_chunks` at `knowledge_documents` and narrowing
   `listMaterialsForCourse`'s `SELECT *`. No UI, no storage. Ends with the
   resolution chain unit-tested and cross-org isolation proven.
2. **Storage binding + routes + tier-1 ingestion + `index.md`/`log.md`
   maintenance.** Ends with a curl-able API.
3. **The five views + homework-form integration.** Ends with #42's acceptance
   criteria met, per-assignment rather than per-course.

## Follow-ups this spec does not cover

- Chunking and embedding of `ready` documents (#40).
- Retrieval, prompt grounding, and citations (#41) — which will consume
  `resolveCollections` and must respect the override chain.
- Whether retrieval should follow `knowledge_links` (OKF progressive disclosure)
  in addition to vector top-k. The link graph is built here; using it is #41's
  decision.
- Cross-course or org-level material reuse, and term rollover (#92).
- Presigned uploads for files above 25 MB.
- Document version history beyond `body_original` and `log.md`.
