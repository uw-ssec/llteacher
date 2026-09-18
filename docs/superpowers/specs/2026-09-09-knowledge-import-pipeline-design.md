# Knowledge import and the ingestion pipeline: full-content OKF with a derived semantic index

Status: approved in discussion 2026-09-09; awaiting user review of this document
Builds on: [2026-09-09-knowledge-management-design.md](./2026-09-09-knowledge-management-design.md) (implemented: PRs #445, #446, and the Phase 3 console)
Coordinates with: #40 (extraction — this spec restructures its scope), #41 (retrieval), #43 (eval harness), #79 (agentic fetch, still deferred)

## Problem

Instructors do not have OKF bundles. A real course folder — surveyed for this design —
looks like this:

```
Ali(Econ 201)/                      529 files, 992 MB
├── Uploaded Lectures/Module 1..10  316 docx, 92 pptx
├── Problem Sets/                   docx
├── Textbook Scans/                 39 pdf (scanned, image-heavy), 5 mp3 (up to 176 MB)
├── Recordings Caption/             71 "txt" files that are actually SubRip transcripts
├── Sample Exams/                   docx
└── Syllabus/                       docx
```

Five findings from that folder are load-bearing:

1. **Zero markdown.** OKF-native bundles are one accepted format (a lossless import
   path used by our own tooling), not the instructor norm.
2. **Extensions lie.** The captions are SRT cue lists saved as `.txt`. Extension-based
   dispatch would import all 71 as prose full of timestamp garbage, when they are the
   best content we handle — transcripts, convertible perfectly today. Ingestion sniffs
   content, then falls back to extension.
3. **527 of 529 paths violate the OKF path alphabet** (spaces, parens, brackets). The
   API's refuse-don't-normalise rule is correct for programmatic callers and wrong for
   imports: imports slugify derived document paths deterministically while the material
   row preserves the original filename verbatim.
4. **8 files exceed the 25 MB Worker body cap** (scanned PDFs, mp3s). The presigned
   direct upload documented as "the way past the cap" stops being optional.
5. **The folder tree is the instructor's own partitioning.** `Module 1..10` is exactly
   the organisation the knowledge base wants. It must survive import.

## The architecture in one paragraph

**One store, one derived index.** OKF documents are authoritative and carry **full
content with relationships** — the agent's job is structure (paths, frontmatter,
splitting, links, descriptions), never summarisation. pgvector chunks derive from
documents and only documents (`material_chunks.document_id`, cascading). Retrieval
composes as **collections filter, embeddings rank**: resolve the attachment chain to a
document set the instructor scoped, then vector-search within it — the tutor can never
retrieve outside what was attached. Link traversal is not part of v1 retrieval (drift
risk; revisit with real logs via #43). Distilled/summary layers, if ever wanted, are
additional concepts linking down to full-text ones, never replacements in the retrieval
path.

## Order of operations

```
            ┌─────────────────────────────────────────────────────────────┐
 upload ──► │ 1. EXTRACT text        deterministic where possible;        │
            │                        model (vision/audio) where not       │
            ├─────────────────────────────────────────────────────────────┤
            │ 2. ONE DOCUMENT PER FILE, immediately                       │
            │    full extracted body · slugified path · cheap type        │
            │    inference · frontmatter status: generated                │
            ├─────────────────────────────────────────────────────────────┤
            │ 3. CHUNK + EMBED those documents                            │
            │    semantic search is live in minutes, not after an agent   │
            ├─────────────────────────────────────────────────────────────┤
            │ 4. AGENT REFINEMENT, later, AS AN EDIT                      │
            │    split files into concepts · frontmatter · descriptions · │
            │    proposed links behind instructor review                  │
            │    (an edit resets index_status → re-chunk: already built)  │
            └─────────────────────────────────────────────────────────────┘
```

Why this order rather than chunking the raw extraction in parallel with OKF synthesis:
if chunks derive from raw text while the agent writes documents separately, an
instructor's edit to a document never reaches retrieval — search and memory drift apart
permanently, and collections (which select documents) cannot scope chunks that belong to
no document. Because the agent structures rather than summarises, a document's body IS
the extraction, so "chunk the extraction" and "chunk the documents" are the same
operation and this ordering loses nothing. Parallelism is in *execution* (extract many
files concurrently), never in *lineage*.

The agent is deliberately just another editor: its refinements go through
`updateDocumentBody`, which already resets `index_status` and rebuilds links. Same door
instructors use, same provenance, same re-chunk machinery. Its improvements are
measurable — run the #43 eval before and after refinement.

### The review gate on generated content

Synthesised structure carries provenance: frontmatter `status: generated` (OKF's own
convention) until an instructor touches it. **Model-proposed links do not silently enter
the graph.** `parseLinks` was deliberately fixed to never invent edges no author wrote —
a phantom edge makes the tutor ground on a relationship that does not exist. An agent
proposing links is that failure mode with better grammar, so proposals surface for
instructor accept/reject before becoming real `knowledge_links` rows. Extraction and
refinement model calls route through the existing LLM plane (gateway + `llm_call_logs`)
so cost and telemetry land with every other model call.

## Import semantics (Upload Material: files and folders)

- **One-shot; collisions are errors.** A file whose derived path already exists is a
  conflict. In-system edits are the source of truth after import.
- **All-or-nothing.** One invalid file fails the batch with a report listing every
  problem; nothing lands until everything passes. Half a bundle is worse than none —
  links into the missing half are all broken. Uses `repositories/atomic.ts` (production
  is neon-http: `db.batch()`, no `db.transaction()`).
- **Bundle `index.md`/`log.md` are skipped and regenerated** after import, plus one log
  entry recording the import ("Imported 43 documents from …"). The system remains the
  sole author of its housekeeping files. (They are doomed on first edit regardless.)
- **Junk is filtered**: `.DS_Store`, empty files. Extension-less files are sniffed;
  if unidentifiable, stored as materials with `status: pending` and a reason.
- **Nothing extractable is rejected for being unextractable.** mp3 and friends are
  accepted, stored, and held at `pending` awaiting the model tier — a folder upload must
  not die on file 3. The allowlist grows to include audio (`mp3`, `m4a`, `wav`).
- **OKF-native bundles import losslessly**: valid frontmatter passes through intact
  (including non-reserved keys — see API gaps below), paths already in the alphabet are
  not re-slugged, markdown links go straight to the parser.

### Structure preservation and collections

- The folder tree is mirrored into knowledge folders: `Uploaded Lectures/Module 1/…` →
  documents under `uploaded-lectures/module-1/…` (slugified, deterministic, collisions
  disambiguated with a numeric suffix).
- **`course_materials` gains a `relative_path` column** (nullable text) recording where
  in the uploaded folder each file came from — the schema is currently flat, and the
  instructor's structure must have somewhere to live for files that are not yet
  documents (audio awaiting transcription, unextracted scans).
- **One collection per top-level folder**, named from it ("Problem Sets", "Uploaded
  Lectures"), each containing its directory item — live subtrees, so later additions
  join. This is the partitioning the instructor already expressed; they can reorganise
  afterwards with the existing collection tools.

### Transport

- The console's Upload Material control accepts files and folders
  (`webkitdirectory`; `webkitRelativePath` supplies the tree).
- ≤ 25 MB: existing multipart POST. Larger: **presigned direct upload** — the Worker
  mints a presigned PUT for the storage key (the machinery Neon Object Storage already
  supports), the browser uploads directly, then confirms to the Worker, which verifies
  with `head()` before creating the material row's final state. The insert-pending-first
  rule holds throughout: nothing claims `ready` (or even `stored`) that is not.
- **Two phases, one atomic boundary.** Bytes are staged first — per-file uploads
  (multipart or presigned) creating material rows in a `staged` state that nothing lists
  or resolves. Then a single **finalize** request carries the manifest (relative paths,
  sniffed kinds, metadata) and performs the knowledge-layer landing — documents, folders,
  collections, link graph — atomically via `atomic.ts`. All-or-nothing governs that
  landing, which is what instructors and links can see; a failed finalize leaves only
  inert staged bytes, reported and re-drivable. This keeps every request under the
  Worker cap regardless of batch size: 529 files is 529 staged uploads plus one small
  finalize.

## API gaps this spec closes

Found during exploration; both corrupt an OKF-native import today:

1. **`createSchema` silently drops non-reserved frontmatter.** The column and repository
   accept it; the route never passes it. OKF's `resource` key — the pointer from concept
   to underlying asset — is lost. The route gains a `frontmatter` passthrough (object,
   validated to exclude the reserved keys, which remain first-class fields).
2. **`log` documents cannot be created via the API** (route accepts `concept | index`;
   the DB enum has `log`). Import regenerates `log.md` server-side, so this is closed by
   the import path writing through the repository — the public route deliberately still
   refuses `log`, because the system is its sole author.

## Extraction tiers (restructures #40's scope)

| Tier | Formats | Mechanism | When |
|---|---|---|---|
| 1 (exists) | md, txt, vtt, srt — **by sniffed content** | string handling | now |
| 2a (this spec) | docx, pptx text runs | deterministic libraries (docx/pptx are zip+XML) | build first |
| 2b (this spec) | scanned/image PDFs, slide visuals | small vision model | behind the same `Extractor` interface |
| 2c (this spec) | mp3, m4a, wav | audio transcription model | same interface |
| 3 (deferred) | agent refinement: splitting, frontmatter, link proposals | agent + review gate | after 2, measured by #43 |

Every tier implements one `Extractor` interface returning markdown + inferred metadata,
so the pipeline cannot tell a library from a model — and 2b/2c can land without touching
the flow. All model tiers run async off the request path (the `status` lifecycle was
built for exactly this), invoked through the LLM plane.

## Sequencing

1. **Transport + structural import** — folder upload end-to-end: manifest, slugging,
   sniffing, all-or-nothing atomic landing, `relative_path`, per-top-folder collections,
   index/log regeneration, frontmatter passthrough, presigned path for large files.
   Ali's folder imports: 71 captions become ready documents; everything else lands as
   organised, collected, `pending` materials.
2. **Tier 2a** — docx/pptx deterministic extraction; the bulk of a real course (408 of
   529 files) becomes full-text documents with live search.
3. **Tiers 2b/2c** — vision + audio behind the `Extractor` interface.
4. **Tier 3** — agent refinement with the review gate, evaluated against #43.

Each stage ships alone and the system is honest at every point: content the pipeline
cannot read yet is visible, organised, and `pending` — never silently dropped, never
falsely `ready`.

## Explicitly out of scope

- Link traversal in retrieval (revisit with #43 evidence)
- Reconcile/re-import of changed bundles (one-shot only; delete-and-reimport meanwhile)
- Distillation layers; relationship inference without review
- Cross-course material reuse (#92 owns rollover)
