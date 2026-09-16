# Course knowledge base as an okf-served OKF bundle: filesystem-authoritative, searched from chat

Status: approved in discussion 2026-09-15; awaiting user review of this document
Supersedes, for the knowledge layer: [2026-09-09-knowledge-management-design.md](./2026-09-09-knowledge-management-design.md) and [2026-09-09-knowledge-import-pipeline-design.md](./2026-09-09-knowledge-import-pipeline-design.md). Their materials, storage, upload validation, and tier-1 conversion sections stand; their Postgres bundle, link graph, collections, and embedding sections are retired by this document.
Issues: [#44](https://github.com/uw-ssec/llteacher/issues/44) epic; [#40](https://github.com/uw-ssec/llteacher/issues/40) extraction (restructured here); [#41](https://github.com/uw-ssec/llteacher/issues/41) retrieval and citations (restructured here); [#42](https://github.com/uw-ssec/llteacher/issues/42) console (repointed here); [#43](https://github.com/uw-ssec/llteacher/issues/43) and [#79](https://github.com/uw-ssec/llteacher/issues/79) deferred past the ship date. Depends on [#82](https://github.com/uw-ssec/llteacher/issues/82) (app on Node compute) and the EFS item this document adds to [#81](https://github.com/uw-ssec/llteacher/issues/81).

## Constraints that shaped this

1. **Two weeks to ship, then live classes for the quarter.** Students and instructors use the result. Anything not on the critical path to "instructor uploads real course files, student asks a question, tutor answers from them with sources" is out.
2. **Real course folders are docx and pptx.** The surveyed Econ 201 folder is 408 docx and pptx out of 529 files, plus SRT captions saved as `.txt`, plus scanned PDFs and audio. Tier-1 conversion reads none of the first group. Extraction is therefore not optional.
3. **One instructor per course this quarter.** A single human writer per bundle is a real property of the deployment and this design leans on it.
4. **AWS and Pulumi are in progress under Kshitij.** The app moving to Node compute (#82) is assumed to land by the end of week one. Nothing in this design runs on the Cloudflare Worker, and that is deliberate: the Worker has no filesystem and cannot spawn a process.
5. **The okf-agent-memory server is the engine the user wants.** Its search and show are what students get in chat, read-only. Its create, update, relate, and bookkeeping are what the app uses to write.

## Decision

**A course's knowledge base is one OKF v0.2 bundle on a shared filesystem, authoritative, served and maintained by the pinned `okf` binary. Postgres stops holding the bundle. The chat handler exposes okf's search and show to students as two read-only tools whose bundle path is forced from the conversation's course. Extraction writes concepts through `okf create`. Search is okf's built-in BM25, lexical only. There are no collections and no embeddings this quarter.**

### Rejected alternatives

- **Keep the Postgres bundle and port search into TypeScript (Postgres full-text).** Runs on the Worker today, reuses three weeks of shipped work. Rejected because the user's goal is the okf server itself as the engine, with one implementation of OKF semantics rather than two, and because the Worker is going away regardless.
- **Postgres authoritative, mirrored to disk for okf.** Every write becomes pull, mutate, push; each Fargate task holds a stale copy until re-sync; the mirror is a cache-coherence problem inside a two-week window. Rejected.
- **S3 as the bundle store with a local cache.** okf needs a real directory. S3 is not one, and the cache is the mirror problem again. EFS is a POSIX filesystem every task mounts identically; use it.
- **Collections and per-assignment scoping.** Answered epic #44's question 4 the way two instructors asked for. Rejected for the quarter because a course-wide bundle collapses the permission layer to a directory boundary, and the tables stay so it can return as a filter in the search function when an instructor asks.
- **Hybrid lexical plus pgvector.** Requires chunking, an embedding provider, an indexing lifecycle, and dimension pinning before students can search anything. Rejected for the quarter; the search interface is one function with one result shape, so a vector leg is additive.
- **MCP stdio client from the chat handler instead of CLI exec.** Same binary, same JSON, more protocol plumbing and a long-lived child process to manage per task. The tool semantics are identical either way. CLI exec now; an MCP client is a transport swap behind the knowledge service, not a redesign. A remote, authenticated okf MCP endpoint for instructors' own agents is a follow-up.

## Architecture

```
                 Fargate task (Node, Hono)                       EFS (shared, POSIX)
  ┌──────────────────────────────────────────────┐    ┌───────────────────────────────┐
  │ chat.ts ── searchKnowledge / showKnowledge ──┼──► │ /mnt/knowledge/courses/       │
  │            (read-only, course forced)        │    │   {courseId}/knowledge/       │
  │                                              │    │     index.md  log.md          │
  │ materials.ts ── Extractor ── okf create ─────┼──► │     lectures/module-1/...md   │
  │                                              │    │     syllabus/...md            │
  │ knowledge routes (console) ── KnowledgeService┼──► │                               │
  │                                              │    └───────────────────────────────┘
  │ KnowledgeService = execFile("okf", [...], {bundle forced}) --json
  └──────────────┬───────────────────────────────┘
                 │ Postgres (RDS): courses, memberships, conversations, messages,
                 │ course_materials (+ document_path), citations (+ concept_path)
                 ▼ S3: material blobs (existing ObjectStore)
```

Four components, each with one job:

| Component | Job | Depends on |
|---|---|---|
| **Bundle store** | One OKF bundle per course at `${KNOWLEDGE_ROOT}/courses/{courseId}/knowledge/`, created by `okf init` on first use | EFS mount, `KNOWLEDGE_ROOT` env |
| **`KnowledgeService`** (`apps/web/src/server/knowledge/service.ts`) | The only code that touches the bundle or the binary. Computes the bundle path from a validated course id, validates concept ids, runs `okf` with an argument array and `--json`, parses results, enforces timeouts and size caps. Implements the two operations okf lacks: delete and rename | `okf` binary, bundle store |
| **Chat tools** (`chat.ts`) | `searchKnowledge` and `showKnowledge` in the existing `TOOLS` catalog, gated by `toolsForConversation`, course id taken from `experimental_context`; show calls recorded for citations | `KnowledgeService` |
| **Extractor** (`apps/web/src/server/knowledge/extract/`) | `(filename, bytes) -> {type, title, markdown} | null`, one implementation per format family, all deterministic; the upload and reingest tail runs it and writes through `KnowledgeService.create` or `update` | `KnowledgeService`, `ObjectStore` |

Postgres keeps identity, enrolment, conversations, messages, `course_materials` with its extraction lifecycle, and citations. It no longer knows what is inside a bundle.

## Bundle layout and conventions

- Root: `${KNOWLEDGE_ROOT}/courses/{courseId}/knowledge/`. `courseId` is validated as a UUID before it is ever joined into a path. `okf init` creates `index.md` (with `okf_version: "0.2"`) and `log.md`.
- Concept ids follow the OKF path alphabet: lowercase letters, digits, hyphen, slash. Import slugifies deterministically; collisions get a numeric suffix. The material row keeps the original filename verbatim.
- Directories come from the instructor's own folder structure on upload (`Uploaded Lectures/Module 1/` becomes `uploaded-lectures/module-1/`). okf maintains each directory's `index.md` and the bundle `log.md` on every create, update, and relate. The service does the same for delete and rename, matching okf's log verbs.
- Frontmatter written by extraction:

  ```yaml
  type: lecture | slides | transcript | syllabus | reading | other   # derived from source_type and content
  title: <from document title, slide deck title, or filename>
  description: <first ~200 characters of body, single line>
  resource: llteacher://materials/{materialId}
  sources: ["<original filename>, uploaded <ISO date>"]
  generated: { by: agent/llteacher-extractor, at: <ISO timestamp> }
  ```

  `generated` is okf's own provenance convention. An instructor edit through the console updates the body through `okf update`, which okf logs; the frontmatter keys above are preserved. `verified` is never written by the app.
- `index.md` and `log.md` are reserved. The service refuses to create, update, or delete them directly; they change only as okf's side effect of another operation.

## `KnowledgeService`

```ts
interface KnowledgeService {
  ensureBundle(courseId: string): Promise<void>;                    // okf init if missing
  list(courseId: string): Promise<ConceptSummary[]>;                 // walk the tree; frontmatter only
  search(courseId: string, query: string, limit?: number): Promise<SearchHit[]>;   // okf search --json
  show(courseId: string, conceptId: string): Promise<Concept | null>;             // okf show --json
  create(courseId: string, input: CreateConcept): Promise<Concept>;                // okf create, then body write via update
  update(courseId: string, conceptId: string, body: string, frontmatter?: Frontmatter): Promise<Concept>;
  relate(courseId: string, from: string, to: string, context: string): Promise<void>;
  remove(courseId: string, conceptId: string): Promise<void>;        // service-implemented
  rename(courseId: string, from: string, to: string): Promise<void>; // service-implemented, no link rewrite
  validate(courseId: string): Promise<ValidationReport>;             // okf validate --json
}
```

Rules that make this safe to expose:

- **The bundle path is never an input.** Every method computes it from `courseId`. The model, the client, and the route never see or pass it.
- **Concept ids are validated before use**: alphabet check, no `.` or `..` segments, no leading slash, resolved path must stay under the bundle root. okf 0.3.0 enforces containment itself (CWE-22 hardening); the service checks first so a rejection is a clean 400 rather than a parsed CLI error.
- **`okf` runs via `execFile` with an argument array**, never a shell string. Per-call timeout of 10 seconds. stdout capped at 4 MB; a search result set is truncated to `limit` (default 8, max 20); a concept body returned to the model is capped at 12,000 characters with a truncation marker.
- **Pinned binary.** The container installs okf 0.3.0 from the GitHub release tarball with a checksum check. A fixture bundle test in CI asserts search ordering and show output for a known bundle so an upgrade cannot silently change behaviour.
- **Single writer.** One instructor per course plus an ECS service with `desiredCount: 1` for the quarter. The service additionally holds a per-course advisory lock file (`.okf-write.lock`, `O_EXCL`) around create, update, relate, remove, and rename so two concurrent console requests from the same instructor cannot interleave index regeneration. Reads take no lock.
- **Delete and rename** are the two operations okf does not offer. The service removes or renames the file, regenerates the parent directory's `index.md` in okf's listing format (`* [Title](path.md) - description`), and appends a `**Deletion**` or `**Rename**` entry to `log.md` under today's date, matching okf's existing verb style. Rename does not rewrite inbound links; they become broken links that `validate` reports and the console shows. Acceptable for one instructor this quarter; link rewriting is a follow-up.

## Student chat tools

Two tools join the `TOOLS` catalog in `chat.ts`, offered by `toolsForConversation` only when the conversation's course bundle has at least one concept (checked once per request via `list`, cached for the request).

```ts
searchKnowledge: { query: string; limit?: number }
  -> { hits: { conceptId, title, type, description, score }[] }

showKnowledge:   { conceptId: string }
  -> { conceptId, title, type, description, body, outbound: conceptId[], inbound: conceptId[] }
     | { error: "not_found" }
```

- **Scope** is `courseId` from `experimental_context`, alongside the `sectionId` already threaded there. The tool never accepts a course or bundle argument.
- **Progressive disclosure in the system prompt.** When the bundle is non-empty, `assembleSystemPrompt` gains one more part: a listing of the bundle's concepts by directory (title and description, from `list`), capped at 6,000 characters with a "and N more; search to find them" tail, followed by an instruction to search or show before answering any question about course material and to say so when nothing relevant is found. When the bundle is empty, nothing is added, which preserves #41's "no empty context block" rule.
- **Untrusted content.** Concept bodies are instructor-uploaded text. The `showKnowledge` result is returned as data and the instruction paragraph tells the model that material content is reference, not instruction. Same posture the retrieval design already required.
- **Citations.** Every successful `showKnowledge` call in a turn is recorded in the tool context; `finalizeAssistantTurn` persists one `citations` row per distinct concept against the assistant message. Search hits are not citations; a concept the model opened is.

## Citations and Sources rendering

`citations` today requires `material_chunk_id`. Two column changes, one migration:

- `material_chunk_id` becomes nullable.
- New `concept_path text` (the OKF concept id) and `course_id uuid` (so a path is unambiguous and tenancy is visible on the row).
- New CHECK `num_nonnulls(material_chunk_id, concept_path) = 1`, following the existing `citations_single_source_chk` pattern. The chunk column stays for the day embeddings return.

The message payload the student UI receives gains `citations: { conceptId: string; title: string }[]` on assistant messages, populated from the persisted rows at read time and from the tool context at stream time. `packages/ui` renders a single collapsible **Sources** list under a grounded reply: title, with the concept id as secondary text. No page numbers this quarter; concepts are whole documents.

## Extraction (restructures #40)

One interface, several implementations, all deterministic, all pure JavaScript with no native dependencies:

| Family | Formats | Mechanism | Output |
|---|---|---|---|
| Text-native (exists) | md, txt, vtt, srt, **sniffed by content**, so SRT-in-`.txt` captions convert | string handling | one concept |
| Word | docx | unzip, read `word/document.xml`, paragraphs and headings to markdown | one concept |
| Slides | pptx | unzip, read `ppt/slides/slideN.xml` in order, text runs under a `## Slide N` heading each | one concept per deck |
| PDF text layer | pdf | Node PDF text extraction; if the text layer is empty or below a density threshold the file is a scan | one concept, or `pending` with reason "no text layer; scanned PDFs are not yet supported" |
| Deferred | scanned PDF, mp3, m4a, wav, images | model tiers, not this quarter | stored, `pending`, reason shown |

Library choice for docx, pptx, and PDF is made in the implementation plan under the constraint above; the interface does not change with it.

Lifecycle, using the columns that already exist plus one new one:

1. Upload validates, stores bytes to S3, inserts `course_materials` at `pending`, and responds 201. Same as today.
2. The handler then schedules extraction in-process (Node has no request CPU cap; the response has already been sent). Status moves to `processing`.
3. Extractor returns markdown. The service derives the concept id from `relative_path` and filename, slugified, and calls `create` with the frontmatter above. `course_materials.document_path` (new nullable text column) records the concept id. Status moves to `ready`.
4. Extractor returns null or throws: status moves to `failed` with `error_detail`, or to `pending` with a reason when the format is recognised but unsupported. Nothing is created in the bundle.
5. Reingest re-runs the extractor and calls `update` on the existing `document_path` concept if present, `create` otherwise.

`course_materials.relative_path` (nullable text) is added as the import-pipeline spec proposed, so folder structure survives even for files that never become concepts.

## Upload of files and folders

- The console's upload control accepts multiple files and folders (`webkitdirectory`). The client loops the existing per-file multipart route, adding a `relativePath` form field from `webkitRelativePath`. No presigned path, no finalize step, no all-or-nothing batch; each file is its own honest row. Files over 25 MB are rejected client-side with the existing message.
- Junk is filtered client-side (`.DS_Store`, zero-byte files).
- Per-top-folder collections are not created. Collections are out of scope.

## Console (repoints #42)

The payload types in `packages/ui/src/api/types.ts` and the five views stay. The document routes are re-implemented over `KnowledgeService`:

| Route | Backed by |
|---|---|
| GET `/knowledge/documents` | `list`, plus `okf validate` broken-link and orphan counts |
| POST `/knowledge/documents` | `create` for a concept; for a folder, the service writes an empty okf-format `index.md` and logs it, since okf has no directory command |
| GET / PUT / DELETE `/knowledge/documents/:id` | `show`, `update`, `remove`; `:id` is the URL-encoded concept path, since there are no UUIDs |
| POST `/knowledge/documents/:id/move` | `rename` |
| GET `/knowledge/documents/:id/links` | `show`'s inbound and outbound plus `validate`'s broken list filtered to this concept |
| GET `/knowledge/search?q=` (new) | `search`; the instructor's way to confirm material is findable, using the exact function students use |

`indexStatus` in payloads is reported as `indexed` for every concept: a concept is searchable the moment it is written, so the value is true rather than a stub. The collections routes are unregistered from `server/index.ts` and the Collections sidebar entry and the Knowledge field on the homework form are removed from the console. Their code stays in the tree for the follow-up that brings scoping back.

## Runtime and infrastructure (what #82 and #81 must provide)

- **Node entry point** for the Hono app using `@hono/node-server`, `makeNodeDb` promoted from test-only to the production client (node-postgres over TCP to RDS), `runAtomically` already handles the transaction path, static assets served from the built `dist`, environment from `process.env` as injected by ECS from Secrets Manager.
- **Container image** with Node 24 and the pinned okf 0.3.0 binary. Health check hits an existing route.
- **EFS** filesystem with an access point, mounted at `/mnt/knowledge` on the task; `KNOWLEDGE_ROOT=/mnt/knowledge`. This is the one item this document adds to #81's list. Backups: EFS automatic backups on; a nightly `tar` of `courses/` to the materials bucket is a follow-up.
- **ECS service `desiredCount: 1`** for the quarter, recorded as a deliberate single-writer choice in `docs/architecture/tech-stack.md`.
- **Local development**: `brew install okf` (pin 0.3.0), `KNOWLEDGE_ROOT=./.knowledge` (git-ignored), Node dev server against the local pgvector container the tests already use.
- **`material_chunks` and the pgvector extension stay** in the schema and in RDS. Nothing writes them this quarter.

## Tenancy and security

- A student reaches a bundle only through a conversation they have access to, which the existing conversation access checks already enforce. The course id comes from that conversation, never from the request body.
- The bundle path is derived, validated, and never exposed. Concept ids are validated twice: by the service and by okf's containment.
- Students get exactly two tools and both are read-only. `create`, `update`, `relate`, `remove`, `rename`, and `validate` are reachable only through instructor-of-course console routes guarded by the existing `requireInstructorOf` pattern.
- Cross-course isolation test: two courses, a concept in each with the same id; `showKnowledge` from course A's conversation must return A's concept and must return `not_found` for a concept that exists only in B.

## Testing

- **Service**: against a temp bundle with the real binary (CI installs okf 0.3.0). Create, update, relate, remove, rename, search ordering on a fixture bundle, id validation rejections, lock contention, timeout behaviour.
- **Tools**: mocked service; scope forced from context; empty bundle offers no tools and injects no listing; show calls become citation rows; body truncation.
- **Citations**: migration applies; CHECK rejects a row with both or neither source; Sources renders from the payload.
- **Extraction**: small fixture docx, pptx, and text PDF checked into the repo with snapshot markdown; a scanned-PDF fixture lands at `pending` with the reason; SRT-in-`.txt` sniffing.
- **Console routes**: temp bundle, instructor-only, reserved-name refusal, `:id` encoding round trip.
- **Conformance**: after the import fixture lands, `okf validate --strict --drift` passes on the produced bundle.
- **Smoke test protocol** (manual, end of week two): import the Econ 201 folder; confirm captions, docx, and pptx become `ready`; ask ten student questions including five paraphrased ones from a section conversation; confirm the model searches, answers from material, and Sources renders; confirm a question about another course's material returns nothing.

## What is retired, what stays

| | Status |
|---|---|
| `knowledge_documents`, `knowledge_links`, `material_collections`, `collection_items`, `collection_attachments`, `material_chunks` tables | **Stay in the schema, unused.** No drop migration this quarter |
| `repositories/knowledgeDocuments.ts`, `knowledgeCollections.ts`, `knowledge/parseLinks.ts`, `knowledge/bundle.ts`, `knowledge/resolveCollections.ts` | Left in the tree, no longer imported by routes; delete after the quarter |
| Collections routes, sidebar entry, homework-form Knowledge field | Unregistered and removed from the UI |
| `course_materials`, `ObjectStore`, upload validation, tier-1 conversion logic | Kept; conversion becomes the text-native `Extractor` |
| Console views for browsing and editing documents | Kept, backed by the filesystem |
| `citations` | Kept, columns changed as above |

## Epic housekeeping

Close-out of this work updates #44: the "grounding toggle is per-course" invariant becomes "scope is the course bundle"; "ready means chunks exist" becomes "ready means a concept exists and is searchable"; "embedding dimension consistency" and "idempotent re-ingest replaces chunks" are marked not applicable this quarter; #43 and #79 are re-labelled off `must-complete: fall-quarter`. `docs/rag-implementation-decisions.md` answers the epic's six questions with the decisions in this document.

## Sequencing (two weeks)

**Week one, the student loop.** Assumes #82 lands by day five; the service, tools, and tests develop locally on Node from day one.
1. `KnowledgeService` over the okf CLI with fixture-bundle tests, id validation, lock, delete and rename.
2. `searchKnowledge` and `showKnowledge`, listing injection, tool gating, cross-course test.
3. Citations migration and persistence; Sources rendering in the student UI.
4. Container image with okf; EFS mount and `KNOWLEDGE_ROOT` agreed with Kshitij; single-task service.

**Week two, the instructor loop and hardening.**
5. `Extractor` for docx, pptx, and text PDF; extraction lifecycle wired into upload and reingest; `document_path` and `relative_path` columns.
6. Console document routes over the service; collections unregistered; instructor search box.
7. Multi-file and folder upload with slugified paths and caption sniffing.
8. Econ 201 smoke test; fixes; epic and decisions doc updates.

**Cut order if it slips**: 7 reduces to multi-select files without folder structure; then PDF extraction drops, keeping docx and pptx; then the instructor search box. Items 1 through 5 are not cuttable.

## Follow-ups this document does not cover

- Collections as a scope filter inside `search` and `show`, restoring per-assignment grounding.
- A vector leg in `search` (hybrid ranking) once #43's baseline shows lexical falling short on real student queries.
- The eval harness (#43) and agentic fetch (#79).
- A remote, authenticated okf MCP endpoint for instructors' and external agents' own tools.
- Git repository per course bundle for document history and export.
- Rename with inbound link rewriting.
- Scanned-PDF and audio extraction; presigned uploads above 25 MB.
- Dropping the retired tables and deleting the retired modules.
