# Knowledge Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give instructors a knowledge-management surface in the admin console — upload materials, organise them as an OKF bundle, group them into collections, and attach collections to a course, homework, section, or tutor config so the tutor grounds on exactly the right material.

**Architecture:** A course's knowledge base is an OKF v0.2 bundle stored in Postgres — `knowledge_documents` rows keyed by path, with markdown links parsed into a `knowledge_links` graph. Uploaded files live in object storage and are referenced by documents. Collections are named selections over the bundle; attachments bind a collection to a scope and resolve most-specific-wins (`section → homework → course → llm_config`), mirroring the existing `prompt_templates` layering.

**Tech Stack:** TypeScript, Hono (Cloudflare Worker), Drizzle ORM + Neon Postgres, Zod, React 19 + Vite + Tailwind 4, Vitest + Testing Library.

**Spec:** [`docs/superpowers/specs/2026-09-09-knowledge-management-design.md`](../specs/2026-09-09-knowledge-management-design.md)

## Global Constraints

- **Never `SELECT *` in a repository.** Project columns explicitly. Drizzle emits the column list from the compiled schema, so an additive column deployed ahead of its migration takes the route down with "column does not exist" instead of degrading.
- **Every repository function takes a branded `CourseScope`**, minted only via `courseScopeFromAuthContext()` in route code. Never `unsafeCourseScope()` outside tests.
- **Every route nests under `/api/courses/:courseId/…`** and is wrapped in `requireInstructorOf()`.
- **Wire types live in `packages/ui/src/api/types.ts`** and are compile-time checked against repository record types using the two-way `extends` pattern in `repositories/llmConfigs.ts:50-55`.
- **Documents are addressed by UUID in URLs, never by path.** Paths contain slashes.
- **`path` stores the OKF concept ID** — the file path *without* `.md`. Directory listings are `<dir>/index`; the bundle log is `log`.
- **Two separate lifecycles:** `course_materials.status` (`pending/processing/ready/failed`) is extraction; `knowledge_documents.index_status` (`pending/indexed/failed`) is chunking. An edit resets only the second.
- **Ingestion tiers:** `txt/md/vtt/srt` convert for real; `pdf/docx/pptx` are stored and held at `status: pending`. Nothing ever falsely reports `ready`.
- Upload cap **25 MB** on the POST-through-Worker path. Allowlist: `pdf, docx, pptx, txt, md, vtt, srt`. (Neon Object Storage itself accepts objects up to 5 GiB; the 25 MB bound is the Worker request body, and presigned direct upload is the documented way past it.)
- DB-backed tests use `describe.skipIf(!DATABASE_URL)` and `makeNodeDb`, following `repositories/llmConfigs.test.ts`.
- All commands run from `apps/web` unless stated. Tests: `npm test -- <path>`. Migrations: `npm run db:generate` then `npm run db:migrate`.
- **Never run `git commit`, `git push`, or `gh pr create` directly.** Commits go through the `/commit` skill and pull requests through `/create-pr`. Task implementers leave their work uncommitted in the working tree and report what they changed; the orchestrator commits at each checkpoint. No `Co-Authored-By` trailers on anything.

---

# Phase 1 — Model (PR 1)

Schema, migration, pure resolution/parsing functions, repositories. No storage, no routes, no UI. Ends with the resolution chain unit-tested and cross-course isolation proven.

---

### Task 1: Enums and the `knowledge_documents` table

**Files:**
- Modify: `apps/web/src/db/schema/content.ts` (append enums near line 41; append table after `agentDefinitions`, ~line 563)
- Create: `apps/web/src/db/migrations/00XX_knowledge_documents.sql` (generated)

**Interfaces:**
- Consumes: existing `courses`, `courseMemberships`, `courseMaterials` from this file.
- Produces: `materialStatusEnum`, `knowledgeDocumentKindEnum`, `knowledgeIndexStatusEnum`, `knowledgeDocuments` table with `$inferSelect` / `$inferInsert`.

Append the tables at the **end** of `content.ts`, after `agentDefinitions`. Every FK then points backwards, so no `AnyPgColumn` forward-reference casts are needed (unlike `promptTemplates`, which sits above `homeworks`).

- [ ] **Step 1: Add the three enums**

Add beside the existing `materialSourceEnum` (`content.ts:41`):

```ts
// Extraction lifecycle of an uploaded artifact: has this file been turned
// into knowledge documents yet? Distinct from a document's index_status,
// which asks whether that document has been chunked. A hand-authored
// document has the second and not the first.
export const materialStatusEnum = pgEnum("material_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);

// OKF reserves index.md (directory listing) and log.md (update history);
// every other .md file is a concept. Storing the kind lets the CHECK
// constraints below reject a concept named `index` or `log`.
export const knowledgeDocumentKindEnum = pgEnum("knowledge_document_kind", [
  "concept",
  "index",
  "log",
]);

// Chunking lifecycle of one document. #40 owns the transition to `indexed`;
// until then every document sits at `pending`.
export const knowledgeIndexStatusEnum = pgEnum("knowledge_index_status", [
  "pending",
  "indexed",
  "failed",
]);
```

- [ ] **Step 2: Append the table at the end of `content.ts`**

```ts
// ---------- KnowledgeDocument ----------
// One .md file in the course's OKF bundle. `path` is the OKF concept ID --
// the file path with the .md suffix removed -- and is therefore identity:
// `stats/regression.md` is stored as `stats/regression`. Directories are
// implicit in paths, exactly as the format has them, so creating a folder
// means creating its `<dir>/index` row; that is what keeps an empty folder
// alive across a reload.

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: knowledgeDocumentKindEnum("kind").notNull().default("concept"),
    /** The one always-required OKF frontmatter key. Null only on index/log
     *  rows, which are not concepts; the CHECK below enforces that. */
    type: text("type"),
    title: text("title"),
    description: text("description"),
    tags: jsonb("tags").$type<string[] | null>(),
    /** Non-reserved frontmatter keys, preserved verbatim so a round-trip
     *  through this console does not silently drop a producer's metadata. */
    frontmatter: jsonb("frontmatter"),
    body: text("body").notNull().default(""),
    /** The extractor's output, kept so "revert to extraction" is possible
     *  after an instructor edits. Null for hand-authored documents. */
    bodyOriginal: text("body_original"),
    indexStatus: knowledgeIndexStatusEnum("index_status")
      .notNull()
      .default("pending"),
    sourceMaterialId: uuid("source_material_id").references(
      () => courseMaterials.id,
      { onDelete: "set null" },
    ),
    editedById: uuid("edited_by_id").references(() => courseMemberships.id, {
      onDelete: "set null",
    }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Paths are identity. This index also serves the prefix queries that
    // back directory listing and subtree selection (`path LIKE 'dir/%'`):
    // course_id equality narrows to one course's bundle first, which is a
    // few hundred rows at most, so a plain btree is enough and a
    // text_pattern_ops index would be machinery for nothing.
    uniqueIndex("knowledge_documents_course_path_uq").on(t.courseId, t.path),
    index("knowledge_documents_source_material_idx").on(t.sourceMaterialId),
    check(
      "knowledge_documents_concept_type_chk",
      sql`${t.kind} <> 'concept' OR ${t.type} IS NOT NULL`,
    ),
    // OKF: index.md and log.md "MUST NOT be used for concept documents".
    // split_part with a negative index requires PG 14+; Neon is 17.
    check(
      "knowledge_documents_reserved_basename_chk",
      sql`(${t.kind} = 'concept' AND split_part(${t.path}, '/', -1) NOT IN ('index', 'log'))
       OR (${t.kind} = 'index'   AND split_part(${t.path}, '/', -1) = 'index')
       OR (${t.kind} = 'log'     AND ${t.path} = 'log')`,
    ),
  ],
);

export const knowledgeDocumentsRelations = relations(
  knowledgeDocuments,
  ({ one, many }) => ({
    course: one(courses, {
      fields: [knowledgeDocuments.courseId],
      references: [courses.id],
    }),
    sourceMaterial: one(courseMaterials, {
      fields: [knowledgeDocuments.sourceMaterialId],
      references: [courseMaterials.id],
    }),
  }),
);
```

Use `({ one })` rather than `({ one, many })` here: `knowledgeLinks` and the
`material_chunks` repoint both arrive in Task 2, which adds the `many(...)`
relations then. This block must compile on its own, and `noUnusedLocals` rejects
an unused `many`.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Generate the migration**

Run: `cd apps/web && npm run db:generate`
Expected: a new `src/db/migrations/00XX_*.sql` creating three enums and `knowledge_documents`. Read it and confirm both CHECK constraints are present — Drizzle sometimes omits `check()` on first generation; if missing, append them to the SQL by hand.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(db): knowledge_documents table for OKF bundles (#42)


---

### Task 2: `knowledge_links`, `course_materials` columns, `material_chunks` repoint

**Files:**
- Modify: `apps/web/src/db/schema/content.ts`
- Create: migration (generated)

**Interfaces:**
- Consumes: `knowledgeDocuments` (Task 1).
- Produces: `knowledgeLinks` table; `courseMaterials` gains `storageKey`, `byteSize`, `contentType`, `checksum`, `status`, `errorDetail`; `materialChunks.materialId` becomes `documentId`.

- [ ] **Step 1: Add the six columns to `courseMaterials`**

Inside the existing `courseMaterials` definition (`content.ts:471`), after `uploadMetadata`:

```ts
    storageKey: text("storage_key"),
    byteSize: integer("byte_size"),
    contentType: text("content_type"),
    /** SHA-256 of the uploaded bytes. Makes re-ingest idempotent per epic
     *  #44's invariant: the same file uploaded twice is recognised rather
     *  than duplicated. */
    checksum: text("checksum"),
    status: materialStatusEnum("status").notNull().default("pending"),
    errorDetail: text("error_detail"),
```

Nullable rather than `.notNull()` because rows may predate this migration; the upload route always populates them.

- [ ] **Step 2: Repoint `material_chunks` at documents**

The chunkable unit is the document, not the upload — one PDF may yield several concepts, and a hand-authored concept has no upload at all. Replace `materialId` in `materialChunks` (`content.ts:508`):

```ts
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
```

Update its two indexes to match:

```ts
    uniqueIndex("material_chunks_document_ordinal_uq").on(
      t.documentId,
      t.ordinal,
    ),
    index("material_chunks_document_idx").on(t.documentId),
```

And `materialChunksRelations` (`content.ts:675`) to point at `knowledgeDocuments`. Remove `chunks: many(materialChunks)` from `courseMaterialsRelations` and add it to `knowledgeDocumentsRelations`.

This is free right now: no ingestion pipeline exists, so the table is empty. Doing it here stops #40 building on the wrong foreign key.

- [ ] **Step 3: Append the `knowledge_links` table**

```ts
// ---------- KnowledgeLink ----------
// The traversable graph. OKF expresses relationships as ordinary markdown
// links, and says "the specific kind ... is conveyed by the surrounding
// prose, not by the link itself" -- so there is no relationship-type column
// here, deliberately. Rebuilt wholesale from a document's body on every
// save; never edited directly.
//
// Broken links are STORED, not dropped. The spec says consumers "MUST
// tolerate broken links"; tolerating them is not the same as hiding them,
// and an instructor who has renamed a document needs to see what it broke.

export const knowledgeLinks = pgTable(
  "knowledge_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    /** The href exactly as written, before resolution. Kept so the UI can
     *  show an instructor what they typed, not what we guessed. */
    rawHref: text("raw_href").notNull(),
    /** The bundle-relative path the href resolves to, with .md and any
     *  anchor stripped. Null for external links, which are not stored. */
    targetPath: text("target_path").notNull(),
    resolvedDocumentId: uuid("resolved_document_id").references(
      () => knowledgeDocuments.id,
      { onDelete: "set null" },
    ),
    isBroken: boolean("is_broken").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("knowledge_links_source_idx").on(t.sourceDocumentId),
    // Backlinks are a query on this column -- no second table.
    index("knowledge_links_resolved_idx").on(t.resolvedDocumentId),
    index("knowledge_links_target_path_idx").on(t.targetPath),
  ],
);

export const knowledgeLinksRelations = relations(knowledgeLinks, ({ one }) => ({
  source: one(knowledgeDocuments, {
    fields: [knowledgeLinks.sourceDocumentId],
    references: [knowledgeDocuments.id],
    relationName: "outboundLinks",
  }),
}));
```

Now widen `knowledgeDocumentsRelations` (Task 1) from `({ one })` to `({ one, many })` and add both `outboundLinks: many(knowledgeLinks)` and `chunks: many(materialChunks)` to it.

- [ ] **Step 4: Typecheck and generate**

Run: `cd apps/web && npm run typecheck && npm run db:generate`
Expected: typecheck PASSES; migration renames `material_chunks.material_id` to `document_id` and repoints the FK. Drizzle may generate a drop-and-add rather than a rename — that is fine, the table is empty.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(db): knowledge_links graph; repoint material_chunks at documents (#42)


---

### Task 3: Collections, items, attachments

**Files:**
- Modify: `apps/web/src/db/schema/content.ts`
- Create: migration (generated)

**Interfaces:**
- Consumes: `knowledgeDocuments`, `courses`, `homeworks`, `sections`, `llmConfigs`, `courseMemberships`.
- Produces: `materialCollections`, `collectionItems`, `collectionAttachments`.

- [ ] **Step 1: Append all three tables**

```ts
// ---------- MaterialCollection ----------
// A named selection over the course's bundle. The unit an instructor
// attaches to an assignment.

export const materialCollections = pgTable(
  "material_collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => courseMemberships.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("material_collections_course_name_uq").on(t.courseId, t.name)],
);

// ---------- CollectionItem ----------
// Exactly one of document_id (a single file) or directory_path (a subtree).
// A directory item resolves LIVE -- `path LIKE directory_path || '/%'` -- so
// a file added to that folder tomorrow is in the collection tomorrow. That
// is what "select the folders that make up a collection" means, and it is
// why this is not a materialised list of document ids.

export const collectionItems = pgTable(
  "collection_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => materialCollections.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => knowledgeDocuments.id, {
      onDelete: "cascade",
    }),
    directoryPath: text("directory_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "collection_items_exactly_one_target_chk",
      sql`num_nonnulls(${t.documentId}, ${t.directoryPath}) = 1`,
    ),
    // Postgres never treats two NULLs as a conflict, so each of these only
    // constrains rows that actually use that column -- same reasoning as
    // prompt_templates' per-scope unique indexes.
    uniqueIndex("collection_items_collection_document_uq").on(
      t.collectionId,
      t.documentId,
    ),
    uniqueIndex("collection_items_collection_directory_uq").on(
      t.collectionId,
      t.directoryPath,
    ),
    index("collection_items_collection_idx").on(t.collectionId),
  ],
);

// ---------- CollectionAttachment ----------
// Deliberately mirrors prompt_templates' scope shape so resolution code
// reads like lib/prompts.ts.
//
// course_id and scope_course_id are different fields doing different jobs
// and both are needed: course_id is the denormalised tenancy guard present
// on EVERY row, so a listing filters by course without joining through four
// possible scope targets; scope_course_id is set only on rows whose
// attachment target IS the course, and is null on homework-, section-, and
// config-scoped rows.

export const collectionAttachments = pgTable(
  "collection_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => materialCollections.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    scopeCourseId: uuid("scope_course_id").references(() => courses.id, {
      onDelete: "cascade",
    }),
    scopeHomeworkId: uuid("scope_homework_id").references(() => homeworks.id, {
      onDelete: "cascade",
    }),
    scopeSectionId: uuid("scope_section_id").references(() => sections.id, {
      onDelete: "cascade",
    }),
    scopeLlmConfigId: uuid("scope_llm_config_id").references(
      () => llmConfigs.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "collection_attachments_exactly_one_scope_chk",
      sql`num_nonnulls(${t.scopeCourseId}, ${t.scopeHomeworkId}, ${t.scopeSectionId}, ${t.scopeLlmConfigId}) = 1`,
    ),
    index("collection_attachments_course_idx").on(t.courseId),
    index("collection_attachments_scope_course_idx").on(t.scopeCourseId),
    index("collection_attachments_scope_homework_idx").on(t.scopeHomeworkId),
    index("collection_attachments_scope_section_idx").on(t.scopeSectionId),
    index("collection_attachments_scope_llm_config_idx").on(t.scopeLlmConfigId),
    // Multiple DISTINCT collections may attach to one target; the same
    // collection may not attach to the same target twice.
    uniqueIndex("collection_attachments_course_uq").on(
      t.collectionId,
      t.scopeCourseId,
    ),
    uniqueIndex("collection_attachments_homework_uq").on(
      t.collectionId,
      t.scopeHomeworkId,
    ),
    uniqueIndex("collection_attachments_section_uq").on(
      t.collectionId,
      t.scopeSectionId,
    ),
    uniqueIndex("collection_attachments_llm_config_uq").on(
      t.collectionId,
      t.scopeLlmConfigId,
    ),
  ],
);

export const materialCollectionsRelations = relations(
  materialCollections,
  ({ one, many }) => ({
    course: one(courses, {
      fields: [materialCollections.courseId],
      references: [courses.id],
    }),
    items: many(collectionItems),
    attachments: many(collectionAttachments),
  }),
);
```

- [ ] **Step 2: Typecheck, generate, migrate**

Run: `cd apps/web && npm run typecheck && npm run db:generate && npm run db:migrate`
Expected: typecheck PASSES, three tables created. `db:migrate` needs `DATABASE_URL`; skip it if you have no database and run it before Task 6.

- [ ] **Step 3: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(db): material collections, items, and scoped attachments (#42)


---

### Task 4: The link parser

**Files:**
- Create: `apps/web/src/server/knowledge/parseLinks.ts`
- Test: `apps/web/src/server/knowledge/parseLinks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseLinks(body: string, fromPath: string): ParsedLink[]` where `ParsedLink = { rawHref: string; targetPath: string }`. Used by Task 6's document repository and Phase 2's document routes.

Pure string handling, no database, no I/O.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseLinks } from "./parseLinks";

describe("parseLinks", () => {
  it("resolves a bundle-absolute link", () => {
    expect(parseLinks("see [regression](/stats/regression)", "intro")).toEqual([
      { rawHref: "/stats/regression", targetPath: "stats/regression" },
    ]);
  });

  it("resolves a relative link against the source directory", () => {
    expect(parseLinks("see [b](b)", "stats/a")).toEqual([
      { rawHref: "b", targetPath: "stats/b" },
    ]);
  });

  it("resolves a parent-relative link", () => {
    expect(parseLinks("see [x](../x)", "stats/week1/a")).toEqual([
      { rawHref: "../x", targetPath: "stats/x" },
    ]);
  });

  it("strips the .md suffix, because paths are concept ids", () => {
    expect(parseLinks("[a](/stats/a.md)", "intro")[0].targetPath).toBe("stats/a");
  });

  it("strips anchors", () => {
    expect(parseLinks("[a](/stats/a#heading)", "intro")[0].targetPath).toBe("stats/a");
  });

  it("ignores external and non-document links", () => {
    const body = "[w](https://x.test) [m](mailto:a@b.test) [h](#local)";
    expect(parseLinks(body, "intro")).toEqual([]);
  });

  it("ignores links inside fenced code blocks", () => {
    const body = "```\n[a](/stats/a)\n```\n[b](/stats/b)";
    expect(parseLinks(body, "intro")).toEqual([
      { rawHref: "/stats/b", targetPath: "stats/b" },
    ]);
  });

  it("deduplicates repeated links to the same target", () => {
    expect(parseLinks("[a](/x) and [again](/x)", "intro")).toHaveLength(1);
  });

  it("returns an empty array for a body with no links", () => {
    expect(parseLinks("plain prose", "intro")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test -- src/server/knowledge/parseLinks.test.ts`
Expected: FAIL — "Failed to resolve import ./parseLinks".

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   OKF link extraction (#42).

   OKF expresses relationships as ordinary markdown links, either
   bundle-absolute (leading "/") or relative to the source concept. The kind
   of relationship is carried by the surrounding prose, not the link, so this
   returns targets only -- there is nothing else to extract.

   Not a full markdown parser on purpose: the only construct that matters is
   `[text](href)`, and pulling in a parser to find it would mean loading a
   markdown AST in a Worker for a regex's worth of work. The one place a
   regex is genuinely wrong is inside fenced code blocks, where a link is a
   literal rather than a reference -- so those are stripped first.
   -------------------------------------------------------------------------- */

export interface ParsedLink {
  /** The href exactly as written, before resolution. */
  rawHref: string;
  /** Bundle-relative concept id: no leading slash, no .md, no anchor. */
  targetPath: string;
}

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** Anything with a scheme, a protocol-relative prefix, or a pure anchor is
 *  not a concept reference. */
const EXTERNAL_RE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Resolves "." and ".." against a directory, without Node's path module —
 *  this runs in a Worker. */
function normalise(segments: string[]): string {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

export function parseLinks(body: string, fromPath: string): ParsedLink[] {
  const prose = body.replace(FENCE_RE, "");
  const fromDir = fromPath.split("/").slice(0, -1);

  const seen = new Set<string>();
  const links: ParsedLink[] = [];

  for (const match of prose.matchAll(LINK_RE)) {
    const rawHref = match[1];
    if (EXTERNAL_RE.test(rawHref)) continue;

    const withoutAnchor = rawHref.split("#")[0];
    if (withoutAnchor === "") continue;

    const withoutSuffix = withoutAnchor.replace(/\.md$/i, "");
    const targetPath = withoutSuffix.startsWith("/")
      ? normalise(withoutSuffix.slice(1).split("/"))
      : normalise([...fromDir, ...withoutSuffix.split("/")]);

    if (targetPath === "" || seen.has(targetPath)) continue;
    seen.add(targetPath);
    links.push({ rawHref, targetPath });
  }

  return links;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npm test -- src/server/knowledge/parseLinks.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(knowledge): parse OKF markdown links into concept targets (#42)


---

### Task 5: The resolution function

**Files:**
- Create: `apps/web/src/server/knowledge/resolveCollections.ts`
- Test: `apps/web/src/server/knowledge/resolveCollections.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveCollections(attachments: CollectionAttachmentRecord[], target: ResolutionTarget): Resolution`, plus the `AttachmentScope`, `CollectionAttachmentRecord`, `ResolutionTarget`, and `Resolution` types. Consumed by Task 7's repository, Phase 2's `/knowledge/resolve` route, and eventually retrieval (#41).

Pure function over an in-memory attachment list. No database — that is the whole point, and it is why the override chain gets table-driven tests.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  resolveCollections,
  type CollectionAttachmentRecord,
  type ResolutionTarget,
} from "./resolveCollections";

const COURSE = "course-1";
const HOMEWORK = "hw-1";
const SECTION = "sec-1";
const CONFIG = "cfg-1";

const atCourse: CollectionAttachmentRecord = {
  collectionId: "col-course",
  scope: { kind: "course", courseId: COURSE },
};
const atHomework: CollectionAttachmentRecord = {
  collectionId: "col-homework",
  scope: { kind: "homework", homeworkId: HOMEWORK },
};
const atSection: CollectionAttachmentRecord = {
  collectionId: "col-section",
  scope: { kind: "section", sectionId: SECTION },
};
const atConfig: CollectionAttachmentRecord = {
  collectionId: "col-config",
  scope: { kind: "llmConfig", llmConfigId: CONFIG },
};

const fullTarget: ResolutionTarget = {
  courseId: COURSE,
  homeworkId: HOMEWORK,
  sectionId: SECTION,
  llmConfigId: CONFIG,
};

describe("resolveCollections", () => {
  it.each([
    ["section wins over everything", [atCourse, atHomework, atSection, atConfig], "section", ["col-section"]],
    ["homework wins when no section attachment", [atCourse, atHomework, atConfig], "homework", ["col-homework"]],
    ["course wins when no section or homework", [atCourse, atConfig], "course", ["col-course"]],
    ["llm config is the last fallback", [atConfig], "llmConfig", ["col-config"]],
    ["nothing attached resolves to none", [], "none", []],
  ])("%s", (_name, attachments, level, collectionIds) => {
    expect(resolveCollections(attachments, fullTarget)).toEqual({ level, collectionIds });
  });

  it("combines multiple collections attached at the winning level", () => {
    const second = { collectionId: "col-homework-2", scope: atHomework.scope };
    const result = resolveCollections([atCourse, atHomework, second], fullTarget);
    expect(result.level).toBe("homework");
    expect(result.collectionIds.sort()).toEqual(["col-homework", "col-homework-2"]);
  });

  it("ignores attachments scoped to a different target at the same level", () => {
    const other = {
      collectionId: "col-other-hw",
      scope: { kind: "homework", homeworkId: "hw-other" } as const,
    };
    expect(resolveCollections([atCourse, other], fullTarget)).toEqual({
      level: "course",
      collectionIds: ["col-course"],
    });
  });

  it("skips levels the target does not name", () => {
    // A course-level question: no homework, no section, no config in play.
    expect(
      resolveCollections([atSection, atHomework, atCourse], { courseId: COURSE }),
    ).toEqual({ level: "course", collectionIds: ["col-course"] });
  });

  it("deduplicates a collection attached twice at the winning level", () => {
    expect(
      resolveCollections([atHomework, { ...atHomework }], fullTarget).collectionIds,
    ).toEqual(["col-homework"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test -- src/server/knowledge/resolveCollections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   Which collections ground a given conversation (#42).

   OVERRIDE, most-specific-wins:

       section → homework → course → llm_config

   The narrowest level carrying ANY attachment supplies the entire corpus;
   collections attached at that same level combine. This matches
   prompt_templates' existing layering (lib/prompts.ts) deliberately -- two
   different inheritance rules on two adjacent instructor-facing features is
   a support burden, not a feature.

   The llm_config level sits at the BOTTOM: a tutor persona's own knowledge
   is a fallback for when the course hierarchy says nothing, not something
   that overrides an instructor's explicit per-assignment choice.

   Pure, and deliberately so. The override chain is the rule an instructor
   will be confused by first, so it gets table-driven tests with no database
   in the way. Retrieval (#41) and the admin console's /knowledge/resolve
   endpoint call this same function, so the console cannot show one answer
   while the tutor uses another.
   -------------------------------------------------------------------------- */

export type AttachmentScope =
  | { kind: "course"; courseId: string }
  | { kind: "homework"; homeworkId: string }
  | { kind: "section"; sectionId: string }
  | { kind: "llmConfig"; llmConfigId: string };

export interface CollectionAttachmentRecord {
  collectionId: string;
  scope: AttachmentScope;
}

/** Where the question is being asked from. Fields are optional because a
 *  course-level query names no homework and a homework-level query names no
 *  section; an absent field skips that level rather than matching null. */
export interface ResolutionTarget {
  courseId: string;
  homeworkId?: string | null;
  sectionId?: string | null;
  llmConfigId?: string | null;
}

export type ResolutionLevel =
  | "section"
  | "homework"
  | "course"
  | "llmConfig"
  | "none";

export interface Resolution {
  level: ResolutionLevel;
  collectionIds: string[];
}

/** Narrowest first. Each entry says how to recognise an attachment at that
 *  level, given the target. Adding a level is one entry, not a new branch. */
function matchersFor(
  target: ResolutionTarget,
): Array<{ level: ResolutionLevel; matches: (s: AttachmentScope) => boolean }> {
  return [
    {
      level: "section",
      matches: (s) =>
        s.kind === "section" && !!target.sectionId && s.sectionId === target.sectionId,
    },
    {
      level: "homework",
      matches: (s) =>
        s.kind === "homework" &&
        !!target.homeworkId &&
        s.homeworkId === target.homeworkId,
    },
    {
      level: "course",
      matches: (s) => s.kind === "course" && s.courseId === target.courseId,
    },
    {
      level: "llmConfig",
      matches: (s) =>
        s.kind === "llmConfig" &&
        !!target.llmConfigId &&
        s.llmConfigId === target.llmConfigId,
    },
  ];
}

export function resolveCollections(
  attachments: readonly CollectionAttachmentRecord[],
  target: ResolutionTarget,
): Resolution {
  for (const { level, matches } of matchersFor(target)) {
    const hits = attachments.filter((a) => matches(a.scope));
    if (hits.length === 0) continue;
    return {
      level,
      collectionIds: [...new Set(hits.map((h) => h.collectionId))],
    };
  }
  return { level: "none", collectionIds: [] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npm test -- src/server/knowledge/resolveCollections.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(knowledge): most-specific-wins collection resolution (#42)


---

### Task 6: The documents repository

**Files:**
- Create: `apps/web/src/server/repositories/knowledgeDocuments.ts`
- Test: `apps/web/src/server/repositories/knowledgeDocuments.db.test.ts`

**Interfaces:**
- Consumes: `parseLinks` (Task 4), `CourseScope` from `./scope`, schema from Task 1–2.
- Produces: `listDocuments`, `getDocument`, `createDocument`, `updateDocumentBody`, `deleteDocument`, `getDocumentLinks`, and the `KnowledgeDocumentRecord` / `KnowledgeDocumentSummary` types. Phase 2's routes call all of these.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courses, organizations } from "../../db/schema";
import { unsafeCourseScope, type CourseScope } from "./scope";
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentLinks,
  listDocuments,
  updateDocumentBody,
} from "./knowledgeDocuments";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("knowledgeDocuments repository", () => {
  let db: Db;
  let courseA: CourseScope;
  let courseB: CourseScope;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `kdoc-${crypto.randomUUID()}`,
        name: "KDoc",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    const made = await db
      .insert(courses)
      .values([
        { organizationId: org.id, code: "A", term: "T", title: "A" },
        { organizationId: org.id, code: "B", term: "T", title: "B" },
      ])
      .returning({ id: courses.id });
    courseA = unsafeCourseScope(made[0].id);
    courseB = unsafeCourseScope(made[1].id);
  });

  it("creates a concept and reads it back by id", async () => {
    const created = await createDocument(db, courseA, {
      path: "stats/regression",
      kind: "concept",
      type: "lecture",
      title: "Regression",
      body: "Linear models.",
    });
    const read = await getDocument(db, courseA, created.id);
    expect(read?.path).toBe("stats/regression");
    expect(read?.type).toBe("lecture");
    expect(read?.indexStatus).toBe("pending");
  });

  it("rejects a duplicate path within one course", async () => {
    await createDocument(db, courseA, { path: "dup", kind: "concept", type: "note", body: "" });
    await expect(
      createDocument(db, courseA, { path: "dup", kind: "concept", type: "note", body: "" }),
    ).rejects.toThrow();
  });

  it("allows the same path in a different course", async () => {
    await createDocument(db, courseA, { path: "shared", kind: "concept", type: "note", body: "" });
    const inB = await createDocument(db, courseB, {
      path: "shared",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(inB.path).toBe("shared");
  });

  it("rejects a concept named index or log", async () => {
    await expect(
      createDocument(db, courseA, { path: "week1/index", kind: "concept", type: "note", body: "" }),
    ).rejects.toThrow();
  });

  it("does not return another course's document", async () => {
    const inB = await createDocument(db, courseB, {
      path: "isolated",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(await getDocument(db, courseA, inB.id)).toBeNull();
  });

  it("lists only the calling course's documents", async () => {
    const listed = await listDocuments(db, courseB);
    expect(listed.every((d) => d.path !== "stats/regression")).toBe(true);
  });

  it("stores resolved links and their backlinks", async () => {
    const target = await createDocument(db, courseA, {
      path: "linkable/target",
      kind: "concept",
      type: "note",
      body: "",
    });
    const source = await createDocument(db, courseA, {
      path: "linkable/source",
      kind: "concept",
      type: "note",
      body: "see [target](/linkable/target)",
    });

    const outbound = await getDocumentLinks(db, courseA, source.id);
    expect(outbound.outbound).toEqual([
      { rawHref: "/linkable/target", targetPath: "linkable/target", resolvedDocumentId: target.id, isBroken: false },
    ]);

    const inbound = await getDocumentLinks(db, courseA, target.id);
    expect(inbound.backlinks.map((b) => b.sourceDocumentId)).toEqual([source.id]);
  });

  it("stores a broken link rather than dropping it", async () => {
    const doc = await createDocument(db, courseA, {
      path: "broken/source",
      kind: "concept",
      type: "note",
      body: "see [gone](/nowhere/at/all)",
    });
    const { outbound } = await getDocumentLinks(db, courseA, doc.id);
    expect(outbound).toEqual([
      { rawHref: "/nowhere/at/all", targetPath: "nowhere/at/all", resolvedDocumentId: null, isBroken: true },
    ]);
  });

  it("editing the body rebuilds links and resets index_status", async () => {
    const doc = await createDocument(db, courseA, {
      path: "edited",
      kind: "concept",
      type: "note",
      body: "see [a](/gone-a)",
    });
    await updateDocumentBody(db, courseA, doc.id, { body: "see [b](/gone-b)", editedById: null });

    const { outbound } = await getDocumentLinks(db, courseA, doc.id);
    expect(outbound.map((l) => l.targetPath)).toEqual(["gone-b"]);
    expect((await getDocument(db, courseA, doc.id))?.indexStatus).toBe("pending");
  });

  it("refuses to delete another course's document", async () => {
    const inB = await createDocument(db, courseB, {
      path: "b-only",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(await deleteDocument(db, courseA, inB.id)).toBeNull();
    expect(await getDocument(db, courseB, inB.id)).not.toBeNull();
  });

  it("returns the removed path, which the route layer needs for log.md", async () => {
    const doc = await createDocument(db, courseA, {
      path: "removable",
      kind: "concept",
      type: "note",
      body: "",
    });
    expect(await deleteDocument(db, courseA, doc.id)).toEqual({ path: "removable" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && DATABASE_URL=$DATABASE_URL npm test -- src/server/repositories/knowledgeDocuments.db.test.ts`
Expected: FAIL — module not found. (With no `DATABASE_URL` the suite skips; that is not a pass. Set one before continuing.)

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   The course's OKF bundle, as rows (#42).

   Every function takes a CourseScope and filters on it. That is the tenancy
   boundary: a document id is a UUID an instructor of another course could
   guess at, so nothing here looks a row up by id alone.

   Link maintenance lives here rather than in the route layer because links
   are derived state -- the graph is a projection of every document's body,
   and a body write that does not rebuild it leaves the graph lying. Any
   caller that can write a body goes through updateDocumentBody.
   -------------------------------------------------------------------------- */

import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { knowledgeDocuments, knowledgeLinks } from "../../db/schema";
import { parseLinks } from "../knowledge/parseLinks";
import type { CourseScope } from "./scope";

export type DocumentKind = (typeof knowledgeDocuments.$inferSelect)["kind"];
export type IndexStatus = (typeof knowledgeDocuments.$inferSelect)["indexStatus"];

/** The list projection: everything a directory listing renders, and nothing
 *  that would drag a full markdown body into a listing query. */
export interface KnowledgeDocumentSummary {
  id: string;
  path: string;
  kind: DocumentKind;
  type: string | null;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  indexStatus: IndexStatus;
  sourceMaterialId: string | null;
  updatedAt: string;
}

export interface KnowledgeDocumentRecord extends KnowledgeDocumentSummary {
  body: string;
  bodyOriginal: string | null;
  frontmatter: unknown;
  editedAt: string | null;
}

export interface CreateDocumentInput {
  path: string;
  kind: DocumentKind;
  type?: string | null;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  frontmatter?: unknown;
  body: string;
  bodyOriginal?: string | null;
  sourceMaterialId?: string | null;
  editedById?: string | null;
}

const SUMMARY_COLUMNS = {
  id: knowledgeDocuments.id,
  path: knowledgeDocuments.path,
  kind: knowledgeDocuments.kind,
  type: knowledgeDocuments.type,
  title: knowledgeDocuments.title,
  description: knowledgeDocuments.description,
  tags: knowledgeDocuments.tags,
  indexStatus: knowledgeDocuments.indexStatus,
  sourceMaterialId: knowledgeDocuments.sourceMaterialId,
  updatedAt: knowledgeDocuments.updatedAt,
} as const;

const RECORD_COLUMNS = {
  ...SUMMARY_COLUMNS,
  body: knowledgeDocuments.body,
  bodyOriginal: knowledgeDocuments.bodyOriginal,
  frontmatter: knowledgeDocuments.frontmatter,
  editedAt: knowledgeDocuments.editedAt,
} as const;

function toIso<T extends { updatedAt: Date; editedAt?: Date | null }>(row: T) {
  return {
    ...row,
    updatedAt: row.updatedAt.toISOString(),
    ...(row.editedAt !== undefined
      ? { editedAt: row.editedAt ? row.editedAt.toISOString() : null }
      : {}),
  };
}

export async function listDocuments(
  db: Db,
  scope: CourseScope,
): Promise<KnowledgeDocumentSummary[]> {
  const rows = await db
    .select(SUMMARY_COLUMNS)
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.courseId, scope))
    .orderBy(knowledgeDocuments.path);
  return rows.map(toIso) as KnowledgeDocumentSummary[];
}

export async function getDocument(
  db: Db,
  scope: CourseScope,
  documentId: string,
): Promise<KnowledgeDocumentRecord | null> {
  const [row] = await db
    .select(RECORD_COLUMNS)
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.courseId, scope),
      ),
    )
    .limit(1);
  return row ? (toIso(row) as KnowledgeDocumentRecord) : null;
}

/** Rebuilds the outbound link rows for one document. Wholesale delete +
 *  insert rather than a diff: a body edit can change every link, the counts
 *  are tiny, and a diff would be more code with more ways to leave a stale
 *  row behind. */
async function rebuildLinks(
  db: Db,
  scope: CourseScope,
  documentId: string,
  path: string,
  body: string,
): Promise<void> {
  await db.delete(knowledgeLinks).where(eq(knowledgeLinks.sourceDocumentId, documentId));

  const parsed = parseLinks(body, path);
  if (parsed.length === 0) return;

  // One query for every target, not one per link.
  const targets = await db
    .select({ id: knowledgeDocuments.id, path: knowledgeDocuments.path })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.courseId, scope),
        inArray(knowledgeDocuments.path, parsed.map((p) => p.targetPath)),
      ),
    );
  const byPath = new Map(targets.map((t) => [t.path, t.id]));

  await db.insert(knowledgeLinks).values(
    parsed.map((link) => {
      const resolvedDocumentId = byPath.get(link.targetPath) ?? null;
      return {
        sourceDocumentId: documentId,
        rawHref: link.rawHref,
        targetPath: link.targetPath,
        resolvedDocumentId,
        isBroken: resolvedDocumentId === null,
      };
    }),
  );
}

export async function createDocument(
  db: Db,
  scope: CourseScope,
  input: CreateDocumentInput,
): Promise<KnowledgeDocumentRecord> {
  const [row] = await db
    .insert(knowledgeDocuments)
    .values({
      courseId: scope,
      path: input.path,
      kind: input.kind,
      type: input.type ?? null,
      title: input.title ?? null,
      description: input.description ?? null,
      tags: input.tags ?? null,
      frontmatter: input.frontmatter ?? null,
      body: input.body,
      bodyOriginal: input.bodyOriginal ?? null,
      sourceMaterialId: input.sourceMaterialId ?? null,
      editedById: input.editedById ?? null,
    })
    .returning(RECORD_COLUMNS);

  await rebuildLinks(db, scope, row.id, row.path, row.body);
  // A new document may satisfy links that were broken until now.
  await reresolveInboundLinks(db, scope, row.path, row.id);
  return toIso(row) as KnowledgeDocumentRecord;
}

/** When a path starts existing (create) or stops existing (delete), links
 *  pointing at it change state. Without this, a broken link stays broken
 *  forever after the instructor creates the document it wanted. */
async function reresolveInboundLinks(
  db: Db,
  scope: CourseScope,
  path: string,
  resolvedDocumentId: string | null,
): Promise<void> {
  const candidates = await db
    .select({ id: knowledgeLinks.id })
    .from(knowledgeLinks)
    .innerJoin(
      knowledgeDocuments,
      eq(knowledgeLinks.sourceDocumentId, knowledgeDocuments.id),
    )
    .where(
      and(
        eq(knowledgeDocuments.courseId, scope),
        eq(knowledgeLinks.targetPath, path),
      ),
    );
  if (candidates.length === 0) return;

  await db
    .update(knowledgeLinks)
    .set({ resolvedDocumentId, isBroken: resolvedDocumentId === null })
    .where(inArray(knowledgeLinks.id, candidates.map((c) => c.id)));
}

export interface UpdateDocumentBodyInput {
  body: string;
  editedById: string | null;
}

/** Editing invalidates indexing, never extraction. Epic #44's "once ready,
 *  status does not revert" is about course_materials.status, which this does
 *  not touch; index_status is a different lifecycle and going back to
 *  pending is exactly right for it. */
export async function updateDocumentBody(
  db: Db,
  scope: CourseScope,
  documentId: string,
  input: UpdateDocumentBodyInput,
): Promise<KnowledgeDocumentRecord | null> {
  const [row] = await db
    .update(knowledgeDocuments)
    .set({
      body: input.body,
      indexStatus: "pending",
      editedById: input.editedById,
      editedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.courseId, scope),
      ),
    )
    .returning(RECORD_COLUMNS);

  if (!row) return null;
  await rebuildLinks(db, scope, row.id, row.path, row.body);
  return toIso(row) as KnowledgeDocumentRecord;
}

/** Returns the removed document's path rather than a boolean: the route layer
 *  needs it to write the `log.md` entry, and `null` carries strictly more
 *  information than `false` at no cost. */
export async function deleteDocument(
  db: Db,
  scope: CourseScope,
  documentId: string,
): Promise<{ path: string } | null> {
  const [row] = await db
    .delete(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.courseId, scope),
      ),
    )
    .returning({ path: knowledgeDocuments.path });

  if (!row) return null;
  // Inbound links survive the delete and become broken, which is what OKF's
  // "consumers MUST tolerate broken links" means in practice.
  await reresolveInboundLinks(db, scope, row.path, null);
  return { path: row.path };
}

export interface DocumentLinks {
  outbound: Array<{
    rawHref: string;
    targetPath: string;
    resolvedDocumentId: string | null;
    isBroken: boolean;
  }>;
  backlinks: Array<{ sourceDocumentId: string; sourcePath: string }>;
}

export async function getDocumentLinks(
  db: Db,
  scope: CourseScope,
  documentId: string,
): Promise<DocumentLinks> {
  const outbound = await db
    .select({
      rawHref: knowledgeLinks.rawHref,
      targetPath: knowledgeLinks.targetPath,
      resolvedDocumentId: knowledgeLinks.resolvedDocumentId,
      isBroken: knowledgeLinks.isBroken,
    })
    .from(knowledgeLinks)
    .innerJoin(
      knowledgeDocuments,
      eq(knowledgeLinks.sourceDocumentId, knowledgeDocuments.id),
    )
    .where(
      and(
        eq(knowledgeLinks.sourceDocumentId, documentId),
        eq(knowledgeDocuments.courseId, scope),
      ),
    );

  const backlinks = await db
    .select({
      sourceDocumentId: knowledgeLinks.sourceDocumentId,
      sourcePath: knowledgeDocuments.path,
    })
    .from(knowledgeLinks)
    .innerJoin(
      knowledgeDocuments,
      eq(knowledgeLinks.sourceDocumentId, knowledgeDocuments.id),
    )
    .where(
      and(
        eq(knowledgeLinks.resolvedDocumentId, documentId),
        eq(knowledgeDocuments.courseId, scope),
      ),
    );

  return { outbound, backlinks };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && DATABASE_URL=$DATABASE_URL npm test -- src/server/repositories/knowledgeDocuments.db.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(knowledge): documents repository with link graph maintenance (#42)


---

### Task 7: The collections repository

**Files:**
- Create: `apps/web/src/server/repositories/knowledgeCollections.ts`
- Test: `apps/web/src/server/repositories/knowledgeCollections.db.test.ts`

**Interfaces:**
- Consumes: `resolveCollections` (Task 5), `CourseScope`, schema from Task 3.
- Produces: `listCollections`, `getCollection`, `createCollection`, `updateCollection`, `deleteCollection`, `setCollectionItems`, `listAttachments`, `attachCollection`, `detachCollection`, `resolveForTarget`, `listDocumentsInCollections`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { courseMemberships, courses, organizations, users } from "../../db/schema";
import { unsafeCourseScope, type CourseScope } from "./scope";
import { createDocument } from "./knowledgeDocuments";
import {
  attachCollection,
  createCollection,
  deleteCollection,
  listCollections,
  listDocumentsInCollections,
  resolveForTarget,
  setCollectionItems,
} from "./knowledgeCollections";

const DATABASE_URL = process.env.DATABASE_URL;

/** `users.email` and `.email_blind_index` are NOT NULL encrypted columns
 *  (AES-256-GCM ciphertext and an HMAC blind index). This suite never reads
 *  them back, so random bytes of the right shape satisfy the branded types
 *  without dragging IdentityCipher into a collections test. Same helper, same
 *  reasoning, as courseMemberships.db.test.ts and submissions.db.test.ts. */
function randomBytes(): never {
  return crypto.getRandomValues(new Uint8Array(16)) as never;
}

describe.skipIf(!DATABASE_URL)("knowledgeCollections repository", () => {
  let db: Db;
  let courseA: CourseScope;
  let courseB: CourseScope;
  let membershipA: string;

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    const [org] = await db
      .insert(organizations)
      .values({
        slug: `kcol-${crypto.randomUUID()}`,
        name: "KCol",
        workosOrganizationId: `w-${crypto.randomUUID()}`,
      })
      .returning({ id: organizations.id });
    const made = await db
      .insert(courses)
      .values([
        { organizationId: org.id, code: "A", term: "T", title: "A" },
        { organizationId: org.id, code: "B", term: "T", title: "B" },
      ])
      .returning({ id: courses.id });
    courseA = unsafeCourseScope(made[0].id);
    courseB = unsafeCourseScope(made[1].id);

    const [user] = await db
      .insert(users)
      .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
      .returning({ id: users.id });
    const [m] = await db
      .insert(courseMemberships)
      .values({ userId: user.id, courseId: courseA, role: "instructor" })
      .returning({ id: courseMemberships.id });
    membershipA = m.id;
  });

  it("creates and lists a collection", async () => {
    const created = await createCollection(db, courseA, {
      name: "Week 1",
      description: "Intro readings",
      createdById: membershipA,
    });
    const listed = await listCollections(db, courseA);
    expect(listed.map((c) => c.id)).toContain(created.id);
    expect(listed.find((c) => c.id === created.id)?.name).toBe("Week 1");
  });

  it("does not list another course's collections", async () => {
    await createCollection(db, courseA, { name: "A only", createdById: membershipA });
    expect((await listCollections(db, courseB)).map((c) => c.name)).not.toContain("A only");
  });

  it("resolves a directory item to its subtree, live", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Subtree",
      createdById: membershipA,
    });
    await createDocument(db, courseA, { path: "wk/a", kind: "concept", type: "n", body: "" });
    await setCollectionItems(db, courseA, collection.id, [{ directoryPath: "wk" }]);

    const before = await listDocumentsInCollections(db, courseA, [collection.id]);
    expect(before.map((d) => d.path)).toEqual(["wk/a"]);

    // Added after the collection was defined; a live subtree picks it up.
    await createDocument(db, courseA, { path: "wk/b", kind: "concept", type: "n", body: "" });
    const after = await listDocumentsInCollections(db, courseA, [collection.id]);
    expect(after.map((d) => d.path).sort()).toEqual(["wk/a", "wk/b"]);
  });

  it("does not let a directory item match a sibling with a shared prefix", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Prefix",
      createdById: membershipA,
    });
    await createDocument(db, courseA, { path: "week/a", kind: "concept", type: "n", body: "" });
    await createDocument(db, courseA, { path: "weekend/b", kind: "concept", type: "n", body: "" });
    await setCollectionItems(db, courseA, collection.id, [{ directoryPath: "week" }]);

    const docs = await listDocumentsInCollections(db, courseA, [collection.id]);
    expect(docs.map((d) => d.path)).toEqual(["week/a"]);
  });

  it("deduplicates a document selected both directly and via its folder", async () => {
    const collection = await createCollection(db, courseA, {
      name: "Overlap",
      createdById: membershipA,
    });
    const doc = await createDocument(db, courseA, {
      path: "ov/a",
      kind: "concept",
      type: "n",
      body: "",
    });
    await setCollectionItems(db, courseA, collection.id, [
      { directoryPath: "ov" },
      { documentId: doc.id },
    ]);
    expect(await listDocumentsInCollections(db, courseA, [collection.id])).toHaveLength(1);
  });

  it("resolves attachments most-specific-wins", async () => {
    const courseLevel = await createCollection(db, courseA, {
      name: "Course default",
      createdById: membershipA,
    });
    await attachCollection(db, courseA, courseLevel.id, { kind: "course", courseId: courseA });

    const resolved = await resolveForTarget(db, courseA, { courseId: courseA });
    expect(resolved.level).toBe("course");
    expect(resolved.collectionIds).toContain(courseLevel.id);
  });

  it("returns level 'none' when nothing is attached", async () => {
    const resolved = await resolveForTarget(db, courseB, { courseId: courseB });
    expect(resolved).toEqual({ level: "none", collectionIds: [] });
  });

  it("refuses to delete another course's collection", async () => {
    const inA = await createCollection(db, courseA, {
      name: "Guarded",
      createdById: membershipA,
    });
    expect(await deleteCollection(db, courseB, inA.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && DATABASE_URL=$DATABASE_URL npm test -- src/server/repositories/knowledgeCollections.db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   Collections: named selections over the bundle, and where they attach (#42).

   The interesting part is listDocumentsInCollections. A directory item
   resolves LIVE rather than being expanded to a document list at save time,
   because "attach the Week 3 folder" should keep meaning that after Week 3
   gains a file. That makes it a prefix query, and the prefix needs the
   trailing slash: without it, directory "week" would swallow "weekend/b".
   -------------------------------------------------------------------------- */

import { and, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  collectionAttachments,
  collectionItems,
  knowledgeDocuments,
  materialCollections,
} from "../../db/schema";
import {
  resolveCollections,
  type AttachmentScope,
  type Resolution,
  type ResolutionTarget,
} from "../knowledge/resolveCollections";
import type { CourseScope } from "./scope";

export interface CollectionRecord {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  directoryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionInput {
  name: string;
  description?: string | null;
  createdById: string;
}

export type CollectionItemInput =
  | { documentId: string; directoryPath?: never }
  | { directoryPath: string; documentId?: never };

const COLLECTION_COLUMNS = {
  id: materialCollections.id,
  name: materialCollections.name,
  description: materialCollections.description,
  createdAt: materialCollections.createdAt,
  updatedAt: materialCollections.updatedAt,
} as const;

/** Item counts come from one grouped query rather than N per collection. */
async function countsFor(
  db: Db,
  collectionIds: string[],
): Promise<Map<string, { documentCount: number; directoryCount: number }>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await db
    .select({
      collectionId: collectionItems.collectionId,
      documentCount: sql<number>`count(${collectionItems.documentId})::int`,
      directoryCount: sql<number>`count(${collectionItems.directoryPath})::int`,
    })
    .from(collectionItems)
    .where(inArray(collectionItems.collectionId, collectionIds))
    .groupBy(collectionItems.collectionId);
  return new Map(rows.map((r) => [r.collectionId, r]));
}

export async function listCollections(
  db: Db,
  scope: CourseScope,
): Promise<CollectionRecord[]> {
  const rows = await db
    .select(COLLECTION_COLUMNS)
    .from(materialCollections)
    .where(eq(materialCollections.courseId, scope))
    .orderBy(materialCollections.name);

  const counts = await countsFor(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    documentCount: counts.get(r.id)?.documentCount ?? 0,
    directoryCount: counts.get(r.id)?.directoryCount ?? 0,
  }));
}

export async function getCollection(
  db: Db,
  scope: CourseScope,
  collectionId: string,
): Promise<CollectionRecord | null> {
  const [row] = await db
    .select(COLLECTION_COLUMNS)
    .from(materialCollections)
    .where(
      and(
        eq(materialCollections.id, collectionId),
        eq(materialCollections.courseId, scope),
      ),
    )
    .limit(1);
  if (!row) return null;
  const counts = await countsFor(db, [row.id]);
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    documentCount: counts.get(row.id)?.documentCount ?? 0,
    directoryCount: counts.get(row.id)?.directoryCount ?? 0,
  };
}

export async function createCollection(
  db: Db,
  scope: CourseScope,
  input: CreateCollectionInput,
): Promise<CollectionRecord> {
  const [row] = await db
    .insert(materialCollections)
    .values({
      courseId: scope,
      name: input.name,
      description: input.description ?? null,
      createdById: input.createdById,
    })
    .returning(COLLECTION_COLUMNS);
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    documentCount: 0,
    directoryCount: 0,
  };
}

export async function updateCollection(
  db: Db,
  scope: CourseScope,
  collectionId: string,
  input: { name?: string; description?: string | null },
): Promise<CollectionRecord | null> {
  const [row] = await db
    .update(materialCollections)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(
        eq(materialCollections.id, collectionId),
        eq(materialCollections.courseId, scope),
      ),
    )
    .returning({ id: materialCollections.id });
  return row ? getCollection(db, scope, row.id) : null;
}

export async function deleteCollection(
  db: Db,
  scope: CourseScope,
  collectionId: string,
): Promise<boolean> {
  const [row] = await db
    .delete(materialCollections)
    .where(
      and(
        eq(materialCollections.id, collectionId),
        eq(materialCollections.courseId, scope),
      ),
    )
    .returning({ id: materialCollections.id });
  return !!row;
}

/** Wholesale replacement, matching the PUT route that calls it: the picker
 *  UI sends the full selection, so a diff would be extra code producing the
 *  same rows. Guarded on scope first so a foreign collection id writes
 *  nothing. */
export async function setCollectionItems(
  db: Db,
  scope: CourseScope,
  collectionId: string,
  items: CollectionItemInput[],
): Promise<boolean> {
  const owned = await getCollection(db, scope, collectionId);
  if (!owned) return false;

  await db.delete(collectionItems).where(eq(collectionItems.collectionId, collectionId));
  if (items.length > 0) {
    await db.insert(collectionItems).values(
      items.map((item) => ({
        collectionId,
        documentId: item.documentId ?? null,
        directoryPath: item.directoryPath ?? null,
      })),
    );
  }
  return true;
}

/** Every document in any of the given collections, deduplicated. A document
 *  selected both directly and through its folder appears once. */
export async function listDocumentsInCollections(
  db: Db,
  scope: CourseScope,
  collectionIds: string[],
): Promise<Array<{ id: string; path: string; indexStatus: string }>> {
  if (collectionIds.length === 0) return [];

  const items = await db
    .select({
      documentId: collectionItems.documentId,
      directoryPath: collectionItems.directoryPath,
    })
    .from(collectionItems)
    .innerJoin(
      materialCollections,
      eq(collectionItems.collectionId, materialCollections.id),
    )
    .where(
      and(
        inArray(collectionItems.collectionId, collectionIds),
        eq(materialCollections.courseId, scope),
      ),
    );

  const documentIds = items.flatMap((i) => (i.documentId ? [i.documentId] : []));
  const directories = items.flatMap((i) => (i.directoryPath ? [i.directoryPath] : []));

  const predicates = [];
  if (documentIds.length > 0) predicates.push(inArray(knowledgeDocuments.id, documentIds));
  // The trailing slash is load-bearing: without it "week" also matches
  // "weekend/b".
  for (const dir of directories) {
    predicates.push(like(knowledgeDocuments.path, `${dir}/%`));
  }
  if (predicates.length === 0) return [];

  const rows = await db
    .selectDistinct({
      id: knowledgeDocuments.id,
      path: knowledgeDocuments.path,
      indexStatus: knowledgeDocuments.indexStatus,
    })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.courseId, scope),
        eq(knowledgeDocuments.kind, "concept"),
        or(...predicates),
      ),
    )
    .orderBy(knowledgeDocuments.path);

  return rows;
}

function scopeToColumns(scope: AttachmentScope) {
  return {
    scopeCourseId: scope.kind === "course" ? scope.courseId : null,
    scopeHomeworkId: scope.kind === "homework" ? scope.homeworkId : null,
    scopeSectionId: scope.kind === "section" ? scope.sectionId : null,
    scopeLlmConfigId: scope.kind === "llmConfig" ? scope.llmConfigId : null,
  };
}

function rowToScope(row: {
  scopeCourseId: string | null;
  scopeHomeworkId: string | null;
  scopeSectionId: string | null;
  scopeLlmConfigId: string | null;
}): AttachmentScope {
  if (row.scopeSectionId) return { kind: "section", sectionId: row.scopeSectionId };
  if (row.scopeHomeworkId) return { kind: "homework", homeworkId: row.scopeHomeworkId };
  if (row.scopeLlmConfigId) return { kind: "llmConfig", llmConfigId: row.scopeLlmConfigId };
  // The CHECK guarantees exactly one is set, so this is the course case.
  return { kind: "course", courseId: row.scopeCourseId! };
}

export async function listAttachments(
  db: Db,
  scope: CourseScope,
): Promise<Array<{ id: string; collectionId: string; scope: AttachmentScope }>> {
  const rows = await db
    .select({
      id: collectionAttachments.id,
      collectionId: collectionAttachments.collectionId,
      scopeCourseId: collectionAttachments.scopeCourseId,
      scopeHomeworkId: collectionAttachments.scopeHomeworkId,
      scopeSectionId: collectionAttachments.scopeSectionId,
      scopeLlmConfigId: collectionAttachments.scopeLlmConfigId,
    })
    .from(collectionAttachments)
    .where(eq(collectionAttachments.courseId, scope));

  return rows.map((r) => ({
    id: r.id,
    collectionId: r.collectionId,
    scope: rowToScope(r),
  }));
}

export async function attachCollection(
  db: Db,
  scope: CourseScope,
  collectionId: string,
  attachmentScope: AttachmentScope,
): Promise<boolean> {
  const owned = await getCollection(db, scope, collectionId);
  if (!owned) return false;

  await db
    .insert(collectionAttachments)
    .values({ collectionId, courseId: scope, ...scopeToColumns(attachmentScope) })
    .onConflictDoNothing();
  return true;
}

export async function detachCollection(
  db: Db,
  scope: CourseScope,
  attachmentId: string,
): Promise<boolean> {
  const [row] = await db
    .delete(collectionAttachments)
    .where(
      and(
        eq(collectionAttachments.id, attachmentId),
        eq(collectionAttachments.courseId, scope),
      ),
    )
    .returning({ id: collectionAttachments.id });
  return !!row;
}

/** The database half of resolution: load this course's attachments, then
 *  hand them to the pure function. The console and retrieval (#41) both come
 *  through here, so they cannot disagree about what the tutor will see. */
export async function resolveForTarget(
  db: Db,
  scope: CourseScope,
  target: ResolutionTarget,
): Promise<Resolution> {
  const attachments = await listAttachments(db, scope);
  return resolveCollections(attachments, target);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && DATABASE_URL=$DATABASE_URL npm test -- src/server/repositories/knowledgeCollections.db.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(knowledge): collections repository with live subtree resolution (#42)


---

### Task 8: Narrow the materials repository projection

**Files:**
- Modify: `apps/web/src/server/repositories/materials.ts`
- Test: `apps/web/src/server/repositories/materials.test.ts` (exists)

**Interfaces:**
- Consumes: `CourseScope`, extended `courseMaterials` (Task 2).
- Produces: `listMaterialsForCourse(db, scope): Promise<MaterialSummary[]>` with an explicit projection. Phase 2's materials route consumes it.

`listMaterialsForCourse` currently does `db.select().from(courseMaterials)` — a `SELECT *`. Task 2 added six columns to that table and Phase 2 adds an upload route that lists it on every page load. Narrow it now, for the reason recorded in `llmConfigs.ts`: Drizzle emits the column list from the compiled schema, so an additive column deployed ahead of its migration takes the route down with "column does not exist" instead of degrading.

- [ ] **Step 1: Write the failing test**

Append to `materials.test.ts`:

```ts
import { listMaterialsForCourse } from "./materials";

it("projects an explicit column list, not the whole row", async () => {
  const rows = await listMaterialsForCourse(db, courseScope);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(
      [
        "byteSize",
        "contentType",
        "errorDetail",
        "id",
        "originalFilename",
        "sourceType",
        "status",
        "title",
        "uploadedAt",
      ].sort(),
    );
  }
});
```

If the existing suite has no `courseScope`/seeded material, seed one in its `beforeAll` following the pattern in `knowledgeDocuments.db.test.ts` Step 1.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && DATABASE_URL=$DATABASE_URL npm test -- src/server/repositories/materials.test.ts`
Expected: FAIL — the row carries `courseId`, `uploadedById`, `uploadMetadata`, `checksum`, `storageKey`, `createdAt`, `updatedAt` too.

- [ ] **Step 3: Implement**

```ts
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { courseMaterials } from "../../db/schema";
import type { CourseScope } from "./scope";

export interface MaterialSummary {
  id: string;
  title: string;
  sourceType: (typeof courseMaterials.$inferSelect)["sourceType"];
  originalFilename: string | null;
  byteSize: number | null;
  contentType: string | null;
  status: (typeof courseMaterials.$inferSelect)["status"];
  errorDetail: string | null;
  uploadedAt: string;
}

/** Explicit projection, not select(). Same reasoning as llmConfigs'
 *  CONFIG_COLUMNS: Drizzle emits the column list from the compiled schema,
 *  so an additive column deployed ahead of its migration takes this route
 *  down with "column does not exist" instead of degrading. storageKey and
 *  checksum are deliberately absent -- nothing in the console renders them,
 *  and a storage key is not something to hand a browser. */
const MATERIAL_COLUMNS = {
  id: courseMaterials.id,
  title: courseMaterials.title,
  sourceType: courseMaterials.sourceType,
  originalFilename: courseMaterials.originalFilename,
  byteSize: courseMaterials.byteSize,
  contentType: courseMaterials.contentType,
  status: courseMaterials.status,
  errorDetail: courseMaterials.errorDetail,
  uploadedAt: courseMaterials.uploadedAt,
} as const;

export async function listMaterialsForCourse(
  db: Db,
  scope: CourseScope,
): Promise<MaterialSummary[]> {
  const rows = await db
    .select(MATERIAL_COLUMNS)
    .from(courseMaterials)
    .where(eq(courseMaterials.courseId, scope))
    .orderBy(courseMaterials.uploadedAt);
  return rows.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString() }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && DATABASE_URL=$DATABASE_URL npm test -- src/server/repositories/materials.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> refactor(materials): explicit column projection instead of SELECT * (#42)


---

### Task 9: Phase 1 gate

- [ ] **Step 1: Full suite and typecheck**

Run from the repo root:

```bash
npm run typecheck && npm run test
```

Expected: PASS across all workspaces. `apps/admin` and `packages/ui` are untouched in this phase and must stay green.

- [ ] **Step 2: Verify the migration applies to a clean database**

Run: `cd apps/web && npm run db:migrate`
Expected: all pending migrations apply with no error. If `material_chunks` fails to alter, confirm the table is empty (`select count(*) from material_chunks`) and re-run.

- [ ] **Step 3: Open the PR**

Invoke the `/create-pr` skill. Suggested title and body:

> **M-KM PR1: knowledge model — OKF documents, links, collections, resolution (#42)**
>
> Phase 1 of docs/superpowers/specs/2026-09-09-knowledge-management-design.md. Schema, migration, pure link parser and resolution function, documents and collections repositories. No storage, routes, or UI yet.
>
> Supersedes #42's per-course grounding toggle and resolves epic #44 design question 4 in favour of per-homework/section granularity.


---

# Phase 2 — Storage, ingestion, and routes (PR 2)

Object storage, the wire contract, tier-1 conversion, bundle maintenance, and every endpoint. Ends with a curl-able API. No UI.

---

### Task 10: The object store

**Files:**
- Create: `apps/web/src/server/storage/objectStore.ts`
- Test: `apps/web/src/server/storage/objectStore.test.ts`
- Test: `apps/web/src/server/storage/objectStore.s3.test.ts`
- Modify: `apps/web/src/shared/types.ts` (the `declare global { interface Env }` block)
- Modify: `apps/web/package.json` (add `aws4fetch`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ObjectStore` interface, `s3ObjectStore(config)`, `memoryObjectStore()`, `materialStorageKey(courseId, materialId, filename)`, `storageFromEnv(env)`. Task 14's upload route consumes all of them.

**Storage is Neon Object Storage, not Cloudflare R2.** It speaks the real S3 wire protocol, it is already in `us-east-2` where this project's database lives, it needs no second vendor account, and — the property that actually matters here — **its buckets are branch-aware**: branching a Neon database forks its buckets with it, copy-on-write. A preview branch gets its own materials without copying a byte. R2 has no equivalent.

`Env` in this project is hand-declared in `src/shared/types.ts`, not generated by `wrangler types`, so the binding is added by editing that interface. There is no `wrangler.jsonc` change: S3 is reached over HTTPS with signed requests, not through a Worker binding.

- [ ] **Step 1: Add the dependency**

Run from `apps/web`: `npm install aws4fetch`

`aws4fetch` is a ~5 KB SigV4 signer built for Workers (the AWS SDK is far too large for a Worker bundle and pulls in Node built-ins). Confirm it lands in `dependencies`, not `devDependencies` — production signs requests with it.

- [ ] **Step 2: Write the failing unit test**

```ts
import { describe, it, expect } from "vitest";
import { materialStorageKey, memoryObjectStore } from "./objectStore";

describe("materialStorageKey", () => {
  it("prefixes by course so deleting a course is a prefix sweep", () => {
    expect(materialStorageKey("c1", "m1", "notes.pdf")).toBe(
      "courses/c1/materials/m1/notes.pdf",
    );
  });

  it("strips path separators from the filename", () => {
    expect(materialStorageKey("c1", "m1", "../../etc/passwd")).toBe(
      "courses/c1/materials/m1/passwd",
    );
  });

  it("falls back to a safe name when the filename is unusable", () => {
    expect(materialStorageKey("c1", "m1", "///")).toBe("courses/c1/materials/m1/upload");
  });
});

describe("memoryObjectStore", () => {
  it("round-trips an object", async () => {
    const store = memoryObjectStore();
    await store.put("k", new TextEncoder().encode("hi").buffer, { contentType: "text/plain" });
    expect(await store.head("k")).toEqual({ key: "k", size: 2, contentType: "text/plain" });
    expect(new TextDecoder().decode(await store.get("k"))).toBe("hi");
  });

  it("returns null for a missing key rather than throwing", async () => {
    const store = memoryObjectStore();
    expect(await store.get("nope")).toBeNull();
    expect(await store.head("nope")).toBeNull();
  });

  it("deletes idempotently", async () => {
    const store = memoryObjectStore();
    await store.put("k", new ArrayBuffer(1), {});
    await store.delete("k");
    await store.delete("k");
    expect(await store.head("k")).toBeNull();
  });
});
```

Run: `cd apps/web && npm test -- src/server/storage/objectStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   Object storage for uploaded materials (#42).

   Backed by Neon Object Storage, which speaks the real S3 wire protocol. Two
   reasons it beats a Cloudflare binding here, beyond avoiding a second
   vendor account:

     · Its buckets are BRANCH-AWARE. Branching a Neon database forks its
       buckets with it, copy-on-write -- so a preview branch gets its own
       materials instantly, without copying a byte. Nothing in R2 does that,
       and this project already branches its database for development.

     · It is S3, so the AWS + Pulumi move (#81) changes an endpoint and a
       pair of credentials, not this file's shape.

   The four-method interface is what keeps that migration cheap: nothing
   outside this file imports an S3 type, so a future implementation swap
   touches one module and no callers.
   -------------------------------------------------------------------------- */

import { AwsClient } from "aws4fetch";

export interface StoredObject {
  key: string;
  size: number;
  contentType: string | null;
}

export interface ObjectStore {
  put(key: string, body: ArrayBuffer, opts: { contentType?: string }): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<StoredObject | null>;
}

/** Course-prefixed on purpose: deleting a course becomes a prefix sweep, and
 *  a key that crosses courses is visibly wrong in a log line rather than
 *  needing a database lookup to notice. */
export function materialStorageKey(
  courseId: string,
  materialId: string,
  filename: string,
): string {
  // Only the basename, and only characters that survive a URL and a bucket
  // listing. A caller cannot traverse out of its own prefix.
  const base = filename.split("/").pop()?.split("\\").pop() ?? "";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return `courses/${courseId}/materials/${materialId}/${safe || "upload"}`;
}

export interface S3StoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

export function s3ObjectStore(config: S3StoreConfig): ObjectStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region ?? "us-east-2",
  });
  const url = (key: string) =>
    `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${key
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

  return {
    async put(key, body, opts) {
      const res = await client.fetch(url(key), {
        method: "PUT",
        body,
        headers: opts.contentType ? { "content-type": opts.contentType } : {},
      });
      if (!res.ok) throw new Error(`storage put failed: ${res.status}`);
    },
    async get(key) {
      const res = await client.fetch(url(key), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage get failed: ${res.status}`);
      return await res.arrayBuffer();
    },
    async delete(key) {
      const res = await client.fetch(url(key), { method: "DELETE" });
      // S3 returns 204 for a delete of a key that was never there. Treat 404
      // the same way so callers can delete idempotently.
      if (!res.ok && res.status !== 404) {
        throw new Error(`storage delete failed: ${res.status}`);
      }
    },
    async head(key) {
      const res = await client.fetch(url(key), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage head failed: ${res.status}`);
      const size = Number(res.headers.get("content-length") ?? "0");
      return { key, size, contentType: res.headers.get("content-type") };
    },
  };
}

/** One place that turns Env into a store, so no route reaches for the
 *  credential names itself. */
export function storageFromEnv(env: Env): ObjectStore {
  return s3ObjectStore({
    endpoint: env.STORAGE_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  });
}

export function memoryObjectStore(): ObjectStore {
  const objects = new Map<string, { body: ArrayBuffer; contentType: string | null }>();
  return {
    async put(key, body, opts) {
      objects.set(key, { body, contentType: opts.contentType ?? null });
    },
    async get(key) {
      return objects.get(key)?.body ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async head(key) {
      const object = objects.get(key);
      return object
        ? { key, size: object.body.byteLength, contentType: object.contentType }
        : null;
    },
  };
}
```

- [ ] **Step 4: Add the four secrets to `Env`**

In `apps/web/src/shared/types.ts`, inside `declare global { interface Env { … } }`:

```ts
    /* #42: Neon Object Storage, reached over the S3 wire protocol rather
       than a Worker binding. Buckets are branch-aware — branching the
       database forks its buckets copy-on-write — which is why this is not
       R2. The AWS move (#81) changes these four values, not the code. */
    STORAGE_ENDPOINT: string;
    STORAGE_BUCKET: string;
    STORAGE_ACCESS_KEY_ID: string;
    STORAGE_SECRET_ACCESS_KEY: string;
```

Add the same four to `apps/web/.dev.vars.example` if that file exists, so the next developer knows they are needed.

- [ ] **Step 5: Write the S3 integration test**

`memoryObjectStore` proves the *interface*. It proves nothing about whether the signed requests are actually correct — and a SigV4 signature that is subtly wrong fails only against a real server. Shipping `s3ObjectStore` with no execution against an S3 endpoint would be exactly the "code that looks complete and was never run" trap.

MinIO speaks the S3 wire protocol and runs locally, so the signing path gets genuinely exercised:

```bash
docker run -d --name llteacher-test-s3 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -p 9000:9000 minio/minio server /data
docker exec llteacher-test-s3 mc alias set local http://localhost:9000 minioadmin minioadmin
docker exec llteacher-test-s3 mc mb local/llteacher-materials
```

```ts
import { describe, it, expect } from "vitest";
import { s3ObjectStore } from "./objectStore";

const S3_ENDPOINT = process.env.S3_TEST_ENDPOINT;

/** Gated like the DB suites: without the endpoint this SKIPS, and a skip is
 *  not a pass. Run it with S3_TEST_ENDPOINT=http://localhost:9000 against the
 *  MinIO container. */
describe.skipIf(!S3_ENDPOINT)("s3ObjectStore against a real S3 endpoint", () => {
  const store = () =>
    s3ObjectStore({
      endpoint: S3_ENDPOINT!,
      bucket: "llteacher-materials",
      accessKeyId: process.env.S3_TEST_KEY ?? "minioadmin",
      secretAccessKey: process.env.S3_TEST_SECRET ?? "minioadmin",
    });

  it("signs a PUT that the server accepts, and reads it back byte-identically", async () => {
    const s = store();
    const key = `courses/c/materials/m/round-trip-${crypto.randomUUID()}.txt`;
    const body = new TextEncoder().encode("hello storage").buffer;

    await s.put(key, body, { contentType: "text/plain" });
    const read = await s.get(key);

    expect(read).not.toBeNull();
    expect(new TextDecoder().decode(read!)).toBe("hello storage");
  });

  it("reports size and content type via HEAD", async () => {
    const s = store();
    const key = `courses/c/materials/m/head-${crypto.randomUUID()}.txt`;
    await s.put(key, new TextEncoder().encode("12345").buffer, { contentType: "text/plain" });

    const meta = await s.head(key);
    expect(meta?.size).toBe(5);
    expect(meta?.contentType).toContain("text/plain");
  });

  it("returns null rather than throwing for a key that does not exist", async () => {
    const s = store();
    expect(await s.get(`courses/c/materials/m/absent-${crypto.randomUUID()}`)).toBeNull();
    expect(await s.head(`courses/c/materials/m/absent-${crypto.randomUUID()}`)).toBeNull();
  });

  it("deletes idempotently, including a key that was never there", async () => {
    const s = store();
    const key = `courses/c/materials/m/del-${crypto.randomUUID()}.txt`;
    await s.put(key, new ArrayBuffer(1), {});
    await s.delete(key);
    await s.delete(key);
    expect(await s.head(key)).toBeNull();
  });

  it("round-trips a key containing characters that need URL encoding", async () => {
    const s = store();
    const key = `courses/c/materials/m/a b+c${crypto.randomUUID()}.txt`;
    await s.put(key, new TextEncoder().encode("x").buffer, {});
    expect(await s.get(key)).not.toBeNull();
  });
});
```

That last case matters: SigV4 signs the canonical URI, so a mismatch between how the key is encoded in the URL and how it is signed produces a `SignatureDoesNotMatch` that only appears for keys with spaces or `+`.

Run: `cd apps/web && S3_TEST_ENDPOINT=http://localhost:9000 npx vitest run src/server/storage/objectStore.s3.test.ts`
Expected: PASS, 5 tests. Confirm the count is non-zero — a skip is not a pass.

- [ ] **Step 6: Run both suites, typecheck, and commit**

Run: `cd apps/web && npm test -- src/server/storage/ && npm run typecheck`
Expected: unit tests PASS (6); the S3 suite skips unless `S3_TEST_ENDPOINT` is set.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(storage): S3-backed ObjectStore over Neon Object Storage (#42)
---

### Task 11: The wire contract

**Files:**
- Modify: `packages/ui/src/api/types.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `MaterialPayload`, `MaterialListPayload`, `KnowledgeDocumentSummaryPayload`, `KnowledgeDocumentPayload`, `DocumentLinksPayload`, `CollectionPayload`, `CollectionListPayload`, `CollectionWriteBody`, `CollectionItemBody`, `AttachmentPayload`, `AttachmentScopePayload`, `AttachmentWriteBody`, `ResolutionPayload`. Consumed by Phase 2's routes and Phase 3's `api-client`.

These are the types both sides compile against — a field renamed on the server and not here stops compiling instead of failing a runtime parse in the console.

- [ ] **Step 1: Append the types**

```ts
/* ---------- Knowledge management (#42) ---------- */

export type MaterialStatus = "pending" | "processing" | "ready" | "failed";
export type MaterialSourceType = "pdf" | "slides" | "transcript" | "syllabus" | "other";
export type KnowledgeIndexStatus = "pending" | "indexed" | "failed";
export type KnowledgeDocumentKind = "concept" | "index" | "log";

export interface MaterialPayload {
  id: string;
  title: string;
  sourceType: MaterialSourceType;
  originalFilename: string | null;
  byteSize: number | null;
  contentType: string | null;
  status: MaterialStatus;
  errorDetail: string | null;
  uploadedAt: IsoDateTime;
}

export interface MaterialListPayload {
  materials: MaterialPayload[];
}

export interface KnowledgeDocumentSummaryPayload {
  id: string;
  path: string;
  kind: KnowledgeDocumentKind;
  type: string | null;
  title: string | null;
  description: string | null;
  tags: string[] | null;
  indexStatus: KnowledgeIndexStatus;
  sourceMaterialId: string | null;
  updatedAt: IsoDateTime;
}

export interface KnowledgeDocumentListPayload {
  documents: KnowledgeDocumentSummaryPayload[];
}

export interface KnowledgeDocumentPayload extends KnowledgeDocumentSummaryPayload {
  body: string;
  bodyOriginal: string | null;
  frontmatter: unknown;
  editedAt: IsoDateTime | null;
}

export interface KnowledgeDocumentWriteBody {
  path?: string;
  type?: string | null;
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  body?: string;
}

export interface DocumentLinksPayload {
  outbound: Array<{
    rawHref: string;
    targetPath: string;
    resolvedDocumentId: string | null;
    isBroken: boolean;
  }>;
  backlinks: Array<{ sourceDocumentId: string; sourcePath: string }>;
}

export interface CollectionPayload {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  directoryCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CollectionListPayload {
  collections: CollectionPayload[];
}

export interface CollectionWriteBody {
  name: string;
  description?: string | null;
}

/** Exactly one field set, mirroring the collection_items CHECK. */
export type CollectionItemBody =
  | { documentId: string; directoryPath?: never }
  | { directoryPath: string; documentId?: never };

export interface CollectionItemsWriteBody {
  items: CollectionItemBody[];
}

export type AttachmentScopePayload =
  | { kind: "course"; courseId: string }
  | { kind: "homework"; homeworkId: string }
  | { kind: "section"; sectionId: string }
  | { kind: "llmConfig"; llmConfigId: string };

export interface AttachmentPayload {
  id: string;
  collectionId: string;
  scope: AttachmentScopePayload;
}

export interface AttachmentListPayload {
  attachments: AttachmentPayload[];
}

export interface AttachmentWriteBody {
  scope: AttachmentScopePayload;
}

/** What the tutor will actually retrieve from, and which level decided it.
 *  `level` is surfaced in the UI so an instructor can see *why* — an
 *  override that silently drops course readings is the failure mode this
 *  field exists to prevent. */
export interface ResolutionPayload {
  level: "section" | "homework" | "course" | "llmConfig" | "none";
  collectionIds: string[];
  documents: Array<{ id: string; path: string; indexStatus: KnowledgeIndexStatus }>;
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `cd packages/ui && npm run typecheck`
Expected: PASS.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(api): wire types for knowledge management (#42)


---

### Task 12: Tier-1 conversion

**Files:**
- Create: `apps/web/src/server/knowledge/convert.ts`
- Test: `apps/web/src/server/knowledge/convert.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `convertToOkf(filename, bytes): ConversionResult | null`, `ALLOWED_EXTENSIONS`, `MAX_UPLOAD_BYTES`, `sourceTypeFor(filename)`. Task 14's upload route consumes all four.

Text-native formats convert for real, now. `pdf/docx/pptx` return `null`, and the caller holds them at `status: pending` — never `ready`. This is what stops the UI from lying about what the tutor can see.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { convertToOkf, sourceTypeFor, MAX_UPLOAD_BYTES } from "./convert";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

describe("convertToOkf", () => {
  it("converts a WebVTT transcript to prose", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Welcome to lecture one.

00:00:04.000 --> 00:00:07.000
Today we cover regression.`;
    const result = convertToOkf("lecture1.vtt", bytes(vtt));
    expect(result).toEqual({
      type: "transcript",
      title: "lecture1",
      markdown: "Welcome to lecture one.\n\nToday we cover regression.",
    });
  });

  it("converts an SRT transcript, dropping cue numbers", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
First line.

2
00:00:04,000 --> 00:00:07,000
Second line.`;
    expect(convertToOkf("talk.srt", bytes(srt))?.markdown).toBe("First line.\n\nSecond line.");
  });

  it("drops WebVTT speaker tags and cue settings", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000 align:start\n<v Sara>Hello.</v>";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Hello.");
  });

  it("passes markdown through unchanged", () => {
    expect(convertToOkf("notes.md", bytes("# Title\n\nBody."))).toEqual({
      type: "note",
      title: "notes",
      markdown: "# Title\n\nBody.",
    });
  });

  it("treats plain text as a note", () => {
    expect(convertToOkf("syllabus.txt", bytes("Week 1"))?.type).toBe("note");
  });

  /* The four cases below are regressions. The first two were silently deleting
     an instructor's words: a bare /-->/ test matched a spoken "A --> B", and
     /^\d+$/ matched a cue whose entire spoken text was a number. Losing a
     lecturer's sentence is a far worse failure than keeping a stray timestamp,
     so these pin the direction as much as the behaviour. */

  it("keeps a spoken line that happens to contain an arrow", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nthe process goes A --> B";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("the process goes A --> B");
  });

  it("keeps a spoken line that is only a number", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\n42\n\n2\n00:00:04,000 --> 00:00:07,000\nThat was the answer.";
    expect(convertToOkf("a.srt", bytes(srt))?.markdown).toBe("42\n\nThat was the answer.");
  });

  it("drops WebVTT NOTE blocks rather than reading them as speech", () => {
    const vtt = "WEBVTT\n\nNOTE a translator comment\n\n00:00:01.000 --> 00:00:04.000\nWelcome.";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Welcome.");
  });

  it("drops a named WebVTT cue identifier, not just a numeric one", () => {
    const vtt = "WEBVTT\n\nintro\n00:00:01.000 --> 00:00:04.000\nWelcome.";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Welcome.");
  });

  it("returns null for formats the pipeline cannot extract yet", () => {
    expect(convertToOkf("paper.pdf", bytes("%PDF-1.7"))).toBeNull();
    expect(convertToOkf("deck.pptx", bytes("PK"))).toBeNull();
    expect(convertToOkf("doc.docx", bytes("PK"))).toBeNull();
  });
});

describe("sourceTypeFor", () => {
  it.each([
    ["a.pdf", "pdf"],
    ["a.pptx", "slides"],
    ["a.vtt", "transcript"],
    ["a.srt", "transcript"],
    ["a.md", "other"],
    ["a.docx", "other"],
  ])("maps %s to %s", (filename, expected) => {
    expect(sourceTypeFor(filename)).toBe(expected);
  });
});

it("caps uploads at 25 MB", () => {
  expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test -- src/server/knowledge/convert.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   Tier-1 ingestion: the conversions that need no model (#42).

   #40 owns extraction from binary formats. This file owns the formats where
   "extraction" is string handling -- and it exists so that the upload path
   is genuinely end-to-end for at least one real instructor use case
   (lecture transcripts) rather than being a stub that stores bytes and
   reports a status nobody can act on.

   convertToOkf returns null for pdf/docx/pptx, and the caller holds those at
   status 'pending' with an explicit note. Nothing here ever produces a
   document that claims to be ready when no text was extracted.
   -------------------------------------------------------------------------- */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ALLOWED_EXTENSIONS = [
  "pdf",
  "docx",
  "pptx",
  "txt",
  "md",
  "vtt",
  "srt",
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export interface ConversionResult {
  /** The OKF `type` frontmatter value — the one always-required key. */
  type: string;
  title: string;
  markdown: string;
}

export function extensionOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** Maps to the existing material_source_type enum. `md`/`txt`/`docx` have no
 *  dedicated member, so they land on `other` rather than growing the enum
 *  for a distinction nothing branches on. */
export function sourceTypeFor(
  filename: string,
): "pdf" | "slides" | "transcript" | "syllabus" | "other" {
  switch (extensionOf(filename)) {
    case "pdf":
      return "pdf";
    case "pptx":
      return "slides";
    case "vtt":
    case "srt":
      return "transcript";
    default:
      return "other";
  }
}

/** A real cue-timing line, anchored at line start: `00:00:01.000 --> 00:00:04.000`
 *  with optional hours and optional trailing cue settings. WebVTT uses `.` for
 *  the fraction, SubRip uses `,`.
 *
 *  Anchoring is the whole point. A bare /-->/ test also matches an instructor
 *  SAYING "the process goes A --> B", and that sentence was being deleted from
 *  the transcript with no error and no trace. Dropping a lecturer's words is a
 *  far worse failure than keeping a stray timestamp, so this errs toward
 *  keeping text. */
const TIMESTAMP_RE =
  /^\s*(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

/** WebVTT blocks that are metadata, not speech. Their contents are notes,
 *  styling, or region definitions and must not reach the prose. */
const METADATA_BLOCK_RE = /^(?:NOTE|STYLE|REGION)\b/;

/** WebVTT speaker voice spans: <v Sara>text</v>. */
const VOICE_RE = /<\/?v[^>]*>/g;

/** Both WebVTT and SubRip are blocks of: an OPTIONAL cue identifier, a timing
 *  line, then the spoken text.
 *
 *  A cue identifier is recognised STRUCTURALLY -- it is whatever sits directly
 *  above a timing line -- rather than by pattern. Matching /^\d+$/ instead was
 *  deleting a cue whose entire spoken text was a number ("42"), and it could
 *  never have handled WebVTT's named identifiers at all. Position identifies a
 *  cue id; shape does not. */
function transcriptToProse(raw: string): string {
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const paragraphs: string[] = [];

  for (const block of blocks) {
    let lines = block.split("\n").map((line) => line.trim()).filter((l) => l !== "");
    if (lines.length === 0) continue;

    // The file header, with or without a title: `WEBVTT` / `WEBVTT - Lecture 1`.
    if (/^WEBVTT\b/.test(lines[0])) lines = lines.slice(1);
    if (lines.length === 0) continue;

    // NOTE / STYLE / REGION blocks are metadata; drop the whole block.
    if (METADATA_BLOCK_RE.test(lines[0])) continue;

    // Strip the timing line, plus a cue identifier if one sits above it.
    if (TIMESTAMP_RE.test(lines[0])) {
      lines = lines.slice(1);
    } else if (lines.length > 1 && TIMESTAMP_RE.test(lines[1])) {
      lines = lines.slice(2);
    }

    const text = lines
      .map((line) => line.replace(VOICE_RE, "").trim())
      .filter((line) => line !== "");

    if (text.length > 0) paragraphs.push(text.join(" "));
  }

  return paragraphs.join("\n\n");
}

export function convertToOkf(
  filename: string,
  bytes: ArrayBuffer,
): ConversionResult | null {
  const extension = extensionOf(filename);
  const title = filename.replace(/\.[^.]+$/, "");

  switch (extension) {
    case "vtt":
    case "srt":
      return {
        type: "transcript",
        title,
        markdown: transcriptToProse(new TextDecoder().decode(bytes)),
      };
    case "md":
    case "txt":
      return {
        type: "note",
        title,
        markdown: new TextDecoder().decode(bytes).trim(),
      };
    default:
      // pdf, docx, pptx: #40's job. Deliberately not a throw -- an
      // un-extractable upload is a normal outcome, not an error.
      return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npm test -- src/server/knowledge/convert.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(knowledge): tier-1 conversion for transcripts, markdown, and text (#42)


---

### Task 13: Bundle maintenance — `index.md` and `log.md`

**Files:**
- Create: `apps/web/src/server/knowledge/bundle.ts`
- Test: `apps/web/src/server/knowledge/bundle.test.ts`

**Interfaces:**
- Consumes: `KnowledgeDocumentSummary` (Task 6).
- Produces: `renderIndex(directoryPath, entries)`, `appendLogEntry(existing, isoDate, message)`, `directoryOf(path)`, `parentDirectories(path)`. Task 15's document routes consume them.

Pure functions. The date is a parameter, never `new Date()` inside — that is what makes them testable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { appendLogEntry, directoryOf, parentDirectories, renderIndex } from "./bundle";

describe("renderIndex", () => {
  it("renders OKF index entries under a heading", () => {
    const markdown = renderIndex("week1", [
      { path: "week1/a", title: "Alpha", description: "First." },
      { path: "week1/b", title: null, description: null },
    ]);
    expect(markdown).toBe(
      "## week1\n\n* [Alpha](/week1/a) - First.\n* [b](/week1/b)\n",
    );
  });

  it("names the root heading rather than printing an empty one", () => {
    expect(renderIndex("", [{ path: "a", title: "A", description: null }])).toBe(
      "## Knowledge base\n\n* [A](/a)\n",
    );
  });

  it("renders an empty directory without an entry list", () => {
    expect(renderIndex("week1", [])).toBe("## week1\n\nNo documents yet.\n");
  });
});

describe("appendLogEntry", () => {
  it("creates the log with a dated heading", () => {
    expect(appendLogEntry("", "2026-09-09", "**Creation** Added week1/a.")).toBe(
      "# Log\n\n## 2026-09-09\n\n**Creation** Added week1/a.\n",
    );
  });

  it("adds to today's existing heading rather than duplicating it", () => {
    const existing = "# Log\n\n## 2026-09-09\n\n**Creation** Added a.\n";
    expect(appendLogEntry(existing, "2026-09-09", "**Update** Edited a.")).toBe(
      "# Log\n\n## 2026-09-09\n\n**Creation** Added a.\n**Update** Edited a.\n",
    );
  });

  it("puts a new date above older ones, newest first", () => {
    const existing = "# Log\n\n## 2026-09-08\n\n**Creation** Added a.\n";
    expect(appendLogEntry(existing, "2026-09-09", "**Update** Edited a.")).toBe(
      "# Log\n\n## 2026-09-09\n\n**Update** Edited a.\n\n## 2026-09-08\n\n**Creation** Added a.\n",
    );
  });

  /* The two cases below are the ones the original splice implementation got
     wrong. They are latent while entries arrive in real time, and reachable the
     moment anything backfills a historical date. */

  it("files a middle date in order rather than assuming it is newest", () => {
    const existing =
      "# Log\n\n## 2026-09-09\n\nnewest.\n\n## 2026-09-07\n\noldest.\n";
    expect(appendLogEntry(existing, "2026-09-08", "middle.")).toBe(
      "# Log\n\n## 2026-09-09\n\nnewest.\n\n## 2026-09-08\n\nmiddle.\n\n## 2026-09-07\n\noldest.\n",
    );
  });

  it("keeps the blank line before the next heading when appending to a middle section", () => {
    const existing =
      "# Log\n\n## 2026-09-09\n\nfirst.\n\n## 2026-09-07\n\noldest.\n";
    const result = appendLogEntry(existing, "2026-09-09", "second.");
    expect(result).toContain("first.\nsecond.\n\n## 2026-09-07");
    // Malformed markdown would run the entry straight into the next heading.
    expect(result).not.toContain("second.\n## 2026-09-07");
  });
});

describe("directoryOf / parentDirectories", () => {
  it("returns the containing directory", () => {
    expect(directoryOf("a/b/c")).toBe("a/b");
    expect(directoryOf("a")).toBe("");
  });

  it("lists every ancestor directory, root first", () => {
    expect(parentDirectories("a/b/c")).toEqual(["", "a", "a/b"]);
    expect(parentDirectories("a")).toEqual([""]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test -- src/server/knowledge/bundle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   OKF bundle housekeeping: index.md and log.md (#42).

   The spec reserves both filenames and pins their shape: index.md is "one or
   more sections, each grouping concepts under a heading" with entries
   formatted `* [Title](url) - description`; log.md is "date-grouped entries,
   newest first" under ISO 8601 headings.

   Maintaining them automatically is what makes the folder tree a real bundle
   rather than a directory listing we happen to render -- another OKF
   consumer pointed at an export of this data gets a conformant bundle, and
   the instructor gets a change history in-format for free.

   Every function here is pure and takes the date as a parameter. That is
   deliberate: a `new Date()` inside would make the log untestable.
   -------------------------------------------------------------------------- */

export interface IndexEntry {
  path: string;
  title: string | null;
  description: string | null;
}

export function directoryOf(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/");
}

/** Every ancestor of a path, root ("") first. Used to decide which index.md
 *  files a create or delete invalidates. */
export function parentDirectories(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  const directories = [""];
  for (let i = 0; i < segments.length; i++) {
    directories.push(segments.slice(0, i + 1).join("/"));
  }
  return directories;
}

export function renderIndex(directoryPath: string, entries: IndexEntry[]): string {
  const heading = directoryPath === "" ? "Knowledge base" : directoryPath;
  if (entries.length === 0) return `## ${heading}\n\nNo documents yet.\n`;

  const lines = entries.map((entry) => {
    const label = entry.title ?? entry.path.split("/").pop() ?? entry.path;
    const suffix = entry.description ? ` - ${entry.description}` : "";
    return `* [${label}](/${entry.path})${suffix}`;
  });
  return `## ${heading}\n\n${lines.join("\n")}\n`;
}

const LOG_HEADER = "# Log";

interface LogSection {
  date: string;
  entries: string[];
}

/** Parsed rather than spliced. The previous implementation inserted a new
 *  heading directly beneath "# Log" on the assumption that an unseen date must
 *  be the newest — so backfilling 09-08 into a log holding 09-09 and 09-07
 *  produced 09-08, 09-09, 09-07, violating OKF's newest-first rule. A
 *  same-date append also ate the blank line before the following heading.
 *
 *  Both were splice bugs, so the splice is gone: parse to sections, edit the
 *  structure, re-render. Ordering and spacing then hold by construction rather
 *  than by getting an index right. */
function parseLog(existing: string): LogSection[] {
  const sections: LogSection[] = [];
  let current: LogSection | null = null;

  for (const line of existing.split("\n")) {
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (heading) {
      current = { date: heading[1], entries: [] };
      sections.push(current);
      continue;
    }
    if (current && line.trim() !== "") current.entries.push(line.trim());
  }
  return sections;
}

function renderLog(sections: LogSection[]): string {
  // ISO-8601 dates sort correctly as plain strings, which is most of why the
  // format is worth insisting on.
  const ordered = [...sections].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const body = ordered
    .map((section) => `## ${section.date}\n\n${section.entries.join("\n")}\n`)
    .join("\n");
  return `${LOG_HEADER}\n\n${body}`;
}

export function appendLogEntry(
  existing: string,
  isoDate: string,
  message: string,
): string {
  const sections = parseLog(existing);
  const section = sections.find((s) => s.date === isoDate);

  if (section) section.entries.push(message);
  else sections.push({ date: isoDate, entries: [message] });

  return renderLog(sections);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npm test -- src/server/knowledge/bundle.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(knowledge): OKF index.md and log.md maintenance (#42)


---

### Task 14: Materials routes

**Files:**
- Create: `apps/web/src/server/routes/materials.ts`
- Test: `apps/web/src/server/routes/materials.test.ts`

**Interfaces:**
- Consumes: `listMaterialsForCourse` (Task 8), `ObjectStore`/`materialStorageKey`/`storageFromEnv` (Task 10), `convertToOkf`/`sourceTypeFor`/`MAX_UPLOAD_BYTES`/`ALLOWED_EXTENSIONS`/`extensionOf` (Task 12), `createDocument` (Task 6).
- Produces: `listMaterialsHandler`, `uploadMaterialHandler`, `deleteMaterialHandler`, `reingestMaterialHandler`. Task 17 registers them.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { listMaterialsHandler, uploadMaterialHandler } from "./materials";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import { memoryObjectStore, StorageError } from "../storage/objectStore";

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored" } as unknown as Env;

const store = memoryObjectStore();

vi.mock("../storage/objectStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage/objectStore")>();
  return { ...actual, storageFromEnv: () => store };
});

const listMaterialsForCourse = vi.fn();
const createDocument = vi.fn();
const insertMaterial = vi.fn();

vi.mock("../repositories/materials", () => ({
  listMaterialsForCourse: (...args: unknown[]) => listMaterialsForCourse(...args),
  insertMaterial: (...args: unknown[]) => insertMaterial(...args),
}));
vi.mock("../repositories/knowledgeDocuments", () => ({
  createDocument: (...args: unknown[]) => createDocument(...args),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function appWith(role: "instructor" | "student") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set(
      "authContext",
      fakeAuthContext({ memberships: [fakeMembership({ courseId: COURSE_ID, role })] }),
    );
    await next();
  });
  app.get("/api/courses/:courseId/materials", listMaterialsHandler);
  app.post("/api/courses/:courseId/materials", uploadMaterialHandler);
  return app;
}

function upload(name: string, body: string, type = "text/plain") {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  return { method: "POST", body: form };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMaterialsForCourse.mockResolvedValue([]);
  insertMaterial.mockResolvedValue({ id: "mat-1" });
  createDocument.mockResolvedValue({ id: "doc-1", path: "lecture1" });
});

describe("materials routes", () => {
  it("lists materials for an instructor", async () => {
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ materials: [] });
  });

  it("refuses a non-member course id", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    const res = await appWith("instructor").request(
      `/api/courses/${other}/materials`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a disallowed extension", async () => {
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("evil.exe", "MZ"),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/file type/i);
    expect(insertMaterial).not.toHaveBeenCalled();
  });

  it("rejects a file over the size cap", async () => {
    const huge = "x".repeat(26 * 1024 * 1024);
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("big.txt", huge),
      TEST_ENV,
    );
    expect(res.status).toBe(413);
    expect(insertMaterial).not.toHaveBeenCalled();
  });

  it("stores a transcript and creates a ready document", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello.";
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", vtt, "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(insertMaterial).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ sourceType: "transcript", status: "ready" }),
    );
    expect(createDocument).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ type: "transcript", body: "Hello." }),
    );
  });

  it("holds a PDF at pending and creates no document", async () => {
    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("paper.pdf", "%PDF-1.7", "application/pdf"),
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(insertMaterial).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ status: "pending" }),
    );
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("reports a retryable storage failure as 503, not a dead end", async () => {
    // Neon answers 503 SlowDown when throttling. An instructor who sees
    // "could not store the uploaded file" has no reason to retry; this
    // asserts the distinction StorageError exists to carry.
    const busy = new StorageError("put", 503);
    vi.spyOn(store, "put").mockRejectedValueOnce(busy);

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT", "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/try uploading again/i);
  });

  it("reports a permanent storage failure as 502", async () => {
    vi.spyOn(store, "put").mockRejectedValueOnce(new StorageError("put", 403));

    const res = await appWith("instructor").request(
      `/api/courses/${COURSE_ID}/materials`,
      upload("lecture1.vtt", "WEBVTT", "text/vtt"),
      TEST_ENV,
    );
    expect(res.status).toBe(502);
  });

  it("does not admit a student", async () => {
    const res = await appWith("student").request(
      `/api/courses/${COURSE_ID}/materials`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test -- src/server/routes/materials.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add `insertMaterial` to the materials repository**

Append to `apps/web/src/server/repositories/materials.ts`:

```ts
import { courseMaterials } from "../../db/schema";

export interface InsertMaterialInput {
  title: string;
  sourceType: (typeof courseMaterials.$inferInsert)["sourceType"];
  originalFilename: string;
  storageKey: string;
  byteSize: number;
  contentType: string | null;
  checksum: string;
  status: "pending" | "processing" | "ready" | "failed";
  errorDetail?: string | null;
  uploadedById: string;
}

export async function insertMaterial(
  db: Db,
  scope: CourseScope,
  input: InsertMaterialInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(courseMaterials)
    .values({
      courseId: scope,
      title: input.title,
      sourceType: input.sourceType,
      originalFilename: input.originalFilename,
      storageKey: input.storageKey,
      byteSize: input.byteSize,
      contentType: input.contentType,
      checksum: input.checksum,
      status: input.status,
      errorDetail: input.errorDetail ?? null,
      uploadedById: input.uploadedById,
    })
    .returning({ id: courseMaterials.id });
  return row;
}

export async function deleteMaterial(
  db: Db,
  scope: CourseScope,
  materialId: string,
): Promise<{ storageKey: string | null } | null> {
  const [row] = await db
    .delete(courseMaterials)
    .where(
      and(eq(courseMaterials.id, materialId), eq(courseMaterials.courseId, scope)),
    )
    .returning({ storageKey: courseMaterials.storageKey });
  return row ?? null;
}
```

Add `and` to the `drizzle-orm` import.

- [ ] **Step 4: Implement the routes**

```ts
/* --------------------------------------------------------------------------
   Course material upload and lifecycle (#42).

   Validation is server-side and authoritative. The console validates too,
   for a fast error, but nothing here trusts it: extension, size, and
   membership are all re-checked.

   The three ingestion tiers live in the upload handler's tail. A file the
   pipeline cannot extract is stored and held at `pending` with an explicit
   error_detail -- not marked ready, and not rejected. An instructor can
   still hand-author a document against it, which is the escape hatch that
   makes tier 2 survivable before #40 lands.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import { makeDb } from "../../db/client";
import type { AppEnv } from "../context";
import { courseScopeFromAuthContext } from "../repositories/scope";
import {
  deleteMaterial,
  insertMaterial,
  listMaterialsForCourse,
} from "../repositories/materials";
import { createDocument } from "../repositories/knowledgeDocuments";
import { materialStorageKey, storageFromEnv, StorageError } from "../storage/objectStore";
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  convertToOkf,
  extensionOf,
  sourceTypeFor,
} from "../knowledge/convert";
import { logServerError } from "../utils/errors";
import type { MaterialListPayload } from "@llteacher/ui/api";

function scopeOf(c: Context<AppEnv>) {
  const authContext = c.get("authContext");
  const courseId = c.req.param("courseId");
  return authContext ? courseScopeFromAuthContext(authContext, courseId) : null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function listMaterialsHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const materials = await listMaterialsForCourse(db, scope);
  return c.json({ materials } satisfies MaterialListPayload);
}

export async function uploadMaterialHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No file was uploaded." }, 400);
  }

  const extension = extensionOf(file.name);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    return c.json(
      { error: `Unsupported file type ".${extension}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.` },
      400,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: `File is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.` },
      413,
    );
  }

  const authContext = c.get("authContext")!;
  const membership = authContext.memberships.find((m) => m.courseId === scope);
  if (!membership) return c.json({ error: "Not permitted." }, 403);

  const bytes = await file.arrayBuffer();
  const checksum = await sha256Hex(bytes);
  const converted = convertToOkf(file.name, bytes);
  const db = makeDb(c.env.DATABASE_URL);

  // Insert first: the row's id is part of the storage key, so a stored
  // object always has a row that names it. The reverse order can strand an
  // object nothing references.
  const material = await insertMaterial(db, scope, {
    title: file.name.replace(/\.[^.]+$/, ""),
    sourceType: sourceTypeFor(file.name),
    originalFilename: file.name,
    storageKey: "",
    byteSize: file.size,
    contentType: file.type || null,
    checksum,
    status: converted ? "ready" : "pending",
    errorDetail: converted
      ? null
      : `Text extraction for .${extension} is not implemented yet (#40). Upload stored; author a document manually to ground on it.`,
    uploadedById: membership.id,
  });

  const key = materialStorageKey(scope, material.id, file.name);
  try {
    await storageFromEnv(c.env).put(key, bytes, {
      contentType: file.type || undefined,
    });
  } catch (error) {
    logServerError("materials.upload", error);
    await deleteMaterial(db, scope, material.id);
    // StorageError carries the status structurally so a throttle is not
    // reported as a dead end. Neon answers 503 SlowDown under load; telling
    // an instructor "could not store the uploaded file" when trying again
    // would have worked is the failure this distinction exists to prevent.
    if (error instanceof StorageError && error.retryable) {
      return c.json(
        { error: "Storage is busy right now. Try uploading again in a moment." },
        503,
      );
    }
    return c.json({ error: "Could not store the uploaded file." }, 502);
  }

  if (converted) {
    await createDocument(db, scope, {
      path: converted.title.replace(/[^A-Za-z0-9._/-]/g, "-"),
      kind: "concept",
      type: converted.type,
      title: converted.title,
      body: converted.markdown,
      bodyOriginal: converted.markdown,
      sourceMaterialId: material.id,
      editedById: membership.id,
    });
  }

  return c.json({ id: material.id, status: converted ? "ready" : "pending" }, 201);
}

export async function deleteMaterialHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const removed = await deleteMaterial(db, scope, c.req.param("materialId"));
  if (!removed) return c.json({ error: "No such material." }, 404);

  if (removed.storageKey) {
    // Best effort: the row is already gone, and a stranded object is a
    // cleanup problem rather than a correctness one.
    try {
      await storageFromEnv(c.env).delete(removed.storageKey);
    } catch (error) {
      logServerError("materials.delete.storage", error);
    }
  }
  return c.body(null, 204);
}
```

Update the `storageKey: ""` placeholder: after `put` succeeds, patch the row with the real key. Add to `repositories/materials.ts`:

```ts
export async function setMaterialStorageKey(
  db: Db,
  scope: CourseScope,
  materialId: string,
  storageKey: string,
): Promise<void> {
  await db
    .update(courseMaterials)
    .set({ storageKey, updatedAt: new Date() })
    .where(
      and(eq(courseMaterials.id, materialId), eq(courseMaterials.courseId, scope)),
    );
}
```

and call `await setMaterialStorageKey(db, scope, material.id, key)` immediately after the successful `put`.

- [ ] **Step 5: Add the retry action**

Issue #42 requires that "failed ingestion shows the error detail and a retry action," and the spec's API table lists `POST /materials/:materialId/reingest`. Without it a `pending` PDF is a dead end in the UI.

Add to `repositories/materials.ts`:

```ts
export async function getMaterialForReingest(
  db: Db,
  scope: CourseScope,
  materialId: string,
): Promise<{ id: string; originalFilename: string | null; storageKey: string | null } | null> {
  const [row] = await db
    .select({
      id: courseMaterials.id,
      originalFilename: courseMaterials.originalFilename,
      storageKey: courseMaterials.storageKey,
    })
    .from(courseMaterials)
    .where(and(eq(courseMaterials.id, materialId), eq(courseMaterials.courseId, scope)))
    .limit(1);
  return row ?? null;
}

export async function setMaterialStatus(
  db: Db,
  scope: CourseScope,
  materialId: string,
  status: "pending" | "processing" | "ready" | "failed",
  errorDetail: string | null,
): Promise<void> {
  await db
    .update(courseMaterials)
    .set({ status, errorDetail, updatedAt: new Date() })
    .where(and(eq(courseMaterials.id, materialId), eq(courseMaterials.courseId, scope)));
}
```

and to `routes/materials.ts`:

```ts
/** Re-runs tier-1 conversion against the stored bytes. For a format the
 *  pipeline still cannot extract this is honest a no-op -- it re-reports
 *  `pending` with the same reason rather than pretending a retry helped,
 *  which is why the response says which happened. */
export async function reingestMaterialHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const materialId = c.req.param("materialId");
  const material = await getMaterialForReingest(db, scope, materialId);
  if (!material || !material.storageKey || !material.originalFilename) {
    return c.json({ error: "No such material." }, 404);
  }

  const bytes = await storageFromEnv(c.env).get(material.storageKey);
  if (!bytes) {
    await setMaterialStatus(db, scope, materialId, "failed", "The stored file is missing.");
    return c.json({ error: "The stored file is missing." }, 404);
  }

  const converted = convertToOkf(material.originalFilename, bytes);
  if (!converted) {
    const extension = extensionOf(material.originalFilename);
    await setMaterialStatus(
      db,
      scope,
      materialId,
      "pending",
      `Text extraction for .${extension} is not implemented yet (#40). Upload stored; author a document manually to ground on it.`,
    );
    return c.json({ status: "pending", documentCreated: false });
  }

  const membershipId =
    c.get("authContext")?.memberships.find((m) => m.courseId === scope)?.id ?? null;
  await createDocument(db, scope, {
    path: converted.title.replace(/[^A-Za-z0-9._/-]/g, "-"),
    kind: "concept",
    type: converted.type,
    title: converted.title,
    body: converted.markdown,
    bodyOriginal: converted.markdown,
    sourceMaterialId: materialId,
    editedById: membershipId,
  });
  await setMaterialStatus(db, scope, materialId, "ready", null);
  return c.json({ status: "ready", documentCreated: true });
}
```

Add these tests:

```ts
it("re-reports pending for a format the pipeline still cannot extract", async () => {
  getMaterialForReingest.mockResolvedValue({
    id: "m2",
    originalFilename: "paper.pdf",
    storageKey: "courses/c/materials/m2/paper.pdf",
  });
  await store.put("courses/c/materials/m2/paper.pdf", new TextEncoder().encode("%PDF").buffer, {});

  const res = await appWith("instructor").request(
    `/api/courses/${COURSE_ID}/materials/m2/reingest`,
    { method: "POST" },
    TEST_ENV,
  );
  expect(await res.json()).toEqual({ status: "pending", documentCreated: false });
  expect(createDocument).not.toHaveBeenCalled();
});

it("marks a material failed when its stored file has gone missing", async () => {
  getMaterialForReingest.mockResolvedValue({
    id: "m3",
    originalFilename: "a.vtt",
    storageKey: "courses/c/materials/m3/missing.vtt",
  });
  const res = await appWith("instructor").request(
    `/api/courses/${COURSE_ID}/materials/m3/reingest`,
    { method: "POST" },
    TEST_ENV,
  );
  expect(res.status).toBe(404);
  expect(setMaterialStatus).toHaveBeenCalledWith(
    expect.anything(), COURSE_ID, "m3", "failed", "The stored file is missing.",
  );
});
```

Extend the `vi.mock("../repositories/materials", …)` factory with `getMaterialForReingest`, `setMaterialStatus`, and `setMaterialStorageKey`.

Scope note: this task owns only `routes/materials.ts` and `repositories/materials.ts`. Registering the route (Task 17), the client method (Task 18), and the Retry button (Task 19) are each specified in the task that owns that file — do not edit those files here.

- [ ] **Step 6: Run to verify it passes, then commit**

Run: `cd apps/web && npm test -- src/server/routes/materials.test.ts && npm run typecheck`
Expected: PASS, 11 tests.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(api): material upload with validation and tiered ingestion (#42)


---

### Task 15: Document routes

**Files:**
- Create: `apps/web/src/server/routes/knowledgeDocuments.ts`
- Test: `apps/web/src/server/routes/knowledgeDocuments.test.ts`

**Interfaces:**
- Consumes: Task 6's repository, Task 13's `renderIndex`/`appendLogEntry`/`parentDirectories`.
- Produces: `listDocumentsHandler`, `createDocumentHandler`, `getDocumentHandler`, `updateDocumentHandler`, `deleteDocumentHandler`, `documentLinksHandler`. Task 17 registers them.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createDocumentHandler,
  deleteDocumentHandler,
  documentLinksHandler,
  getDocumentHandler,
  listDocumentsHandler,
  updateDocumentHandler,
} from "./knowledgeDocuments";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const DOC_ID = "22222222-2222-4333-8444-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const repo = {
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocumentBody: vi.fn(),
  deleteDocument: vi.fn(),
  getDocumentLinks: vi.fn(),
};

vi.mock("../repositories/knowledgeDocuments", () => ({
  listDocuments: (...a: unknown[]) => repo.listDocuments(...a),
  getDocument: (...a: unknown[]) => repo.getDocument(...a),
  createDocument: (...a: unknown[]) => repo.createDocument(...a),
  updateDocumentBody: (...a: unknown[]) => repo.updateDocumentBody(...a),
  deleteDocument: (...a: unknown[]) => repo.deleteDocument(...a),
  getDocumentLinks: (...a: unknown[]) => repo.getDocumentLinks(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set(
      "authContext",
      fakeAuthContext({
        memberships: [fakeMembership({ courseId: COURSE_ID, role: "instructor" })],
      }),
    );
    await next();
  });
  a.get("/api/courses/:courseId/knowledge/documents", listDocumentsHandler);
  a.post("/api/courses/:courseId/knowledge/documents", createDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId", getDocumentHandler);
  a.put("/api/courses/:courseId/knowledge/documents/:documentId", updateDocumentHandler);
  a.delete("/api/courses/:courseId/knowledge/documents/:documentId", deleteDocumentHandler);
  a.get("/api/courses/:courseId/knowledge/documents/:documentId/links", documentLinksHandler);
  return a;
}

const base = `/api/courses/${COURSE_ID}/knowledge/documents`;
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.listDocuments.mockResolvedValue([]);
  repo.createDocument.mockResolvedValue({ id: DOC_ID, path: "a" });
});

describe("knowledge document routes", () => {
  it("lists documents", async () => {
    const res = await app().request(base, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documents: [] });
  });

  it("rejects a path with a traversal segment", async () => {
    const res = await app().request(
      base,
      json({ path: "../escape", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("rejects a leading or trailing slash in a path", async () => {
    const res = await app().request(
      base,
      json({ path: "/leading", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a concept with no type, the one required OKF key", async () => {
    const res = await app().request(base, json({ path: "a", kind: "concept" }), TEST_ENV);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/type/i);
  });

  it("rejects a concept named index", async () => {
    const res = await app().request(
      base,
      json({ path: "week1/index", kind: "concept", type: "note" }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reserved/i);
  });

  it("creates a folder as its index document", async () => {
    const res = await app().request(base, json({ path: "week1", kind: "index" }), TEST_ENV);
    expect(res.status).toBe(201);
    expect(repo.createDocument).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      expect.objectContaining({ path: "week1/index", kind: "index" }),
    );
  });

  it("returns 404 for a document in another course", async () => {
    repo.getDocument.mockResolvedValue(null);
    const res = await app().request(`${base}/${DOC_ID}`, {}, TEST_ENV);
    expect(res.status).toBe(404);
  });

  it("updates a body", async () => {
    repo.updateDocumentBody.mockResolvedValue({ id: DOC_ID, path: "a", body: "new" });
    const res = await app().request(`${base}/${DOC_ID}`, json({ body: "new" }, "PUT"), TEST_ENV);
    expect(res.status).toBe(200);
    expect(repo.updateDocumentBody).toHaveBeenCalledWith(
      expect.anything(),
      COURSE_ID,
      DOC_ID,
      expect.objectContaining({ body: "new" }),
    );
  });

  it("returns outbound links and backlinks", async () => {
    repo.getDocumentLinks.mockResolvedValue({ outbound: [], backlinks: [] });
    const res = await app().request(`${base}/${DOC_ID}/links`, {}, TEST_ENV);
    expect(await res.json()).toEqual({ outbound: [], backlinks: [] });
  });

  it("returns 404 when deleting a document that is not this course's", async () => {
    repo.deleteDocument.mockResolvedValue(false);
    const res = await app().request(`${base}/${DOC_ID}`, { method: "DELETE" }, TEST_ENV);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test -- src/server/routes/knowledgeDocuments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   The bundle's documents (#42).

   Path validation is the security-relevant part of this file. `path` becomes
   a database identity and is rendered into markdown links, so a traversal
   segment or a leading slash is refused here rather than normalised --
   silently rewriting a caller's path produces a document at an address they
   did not ask for, which is worse than an error.

   Creating a FOLDER means creating its index document: OKF has no directory
   entity, directories are implicit in paths, and an index.md is both the
   format's directory listing and the thing that keeps an empty folder alive
   across a reload.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import { z } from "zod";
import { makeDb } from "../../db/client";
import type { AppEnv } from "../context";
import { courseScopeFromAuthContext } from "../repositories/scope";
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentLinks,
  listDocuments,
  updateDocumentBody,
} from "../repositories/knowledgeDocuments";
import type {
  DocumentLinksPayload,
  KnowledgeDocumentListPayload,
} from "@llteacher/ui/api";

/** Segments are the OKF concept-id alphabet: no slashes at the ends, no
 *  empty or dot segments, nothing that needs escaping in a markdown link. */
const PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const RESERVED_BASENAMES = new Set(["index", "log"]);

const createSchema = z.object({
  path: z.string().min(1).max(400),
  kind: z.enum(["concept", "index"]),
  type: z.string().min(1).max(80).optional(),
  title: z.string().max(300).nullish(),
  description: z.string().max(1000).nullish(),
  tags: z.array(z.string().max(80)).nullish(),
  body: z.string().default(""),
  sourceMaterialId: z.string().uuid().nullish(),
});

const updateSchema = z.object({
  body: z.string(),
});

function scopeOf(c: Context<AppEnv>) {
  const authContext = c.get("authContext");
  const courseId = c.req.param("courseId");
  return authContext ? courseScopeFromAuthContext(authContext, courseId) : null;
}

function membershipIdOf(c: Context<AppEnv>, courseId: string): string | null {
  return c.get("authContext")?.memberships.find((m) => m.courseId === courseId)?.id ?? null;
}

export async function listDocumentsHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const documents = await listDocuments(makeDb(c.env.DATABASE_URL), scope);
  return c.json({ documents } satisfies KnowledgeDocumentListPayload);
}

export async function createDocumentHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid document." }, 400);
  const input = parsed.data;

  if (!PATH_RE.test(input.path)) {
    return c.json(
      { error: "Path must be slash-separated names using letters, numbers, dot, dash, or underscore." },
      400,
    );
  }
  if (input.path.split("/").some((segment) => segment === "." || segment === "..")) {
    return c.json({ error: "Path may not contain . or .. segments." }, 400);
  }

  // A folder is its index document. The caller names the directory; we
  // append the reserved basename.
  const path = input.kind === "index" ? `${input.path}/index` : input.path;

  if (input.kind === "concept") {
    if (!input.type) {
      return c.json({ error: "A concept needs a `type` — it is OKF's one required key." }, 400);
    }
    if (RESERVED_BASENAMES.has(path.split("/").pop()!)) {
      return c.json({ error: "`index` and `log` are reserved OKF filenames." }, 400);
    }
  }

  const db = makeDb(c.env.DATABASE_URL);
  try {
    const created = await createDocument(db, scope, {
      path,
      kind: input.kind,
      type: input.kind === "concept" ? input.type! : null,
      title: input.title ?? null,
      description: input.description ?? null,
      tags: input.tags ?? null,
      body: input.body,
      sourceMaterialId: input.sourceMaterialId ?? null,
      editedById: membershipIdOf(c, scope),
    });
    return c.json(created, 201);
  } catch {
    // The only constraint a well-formed request can hit is the path unique
    // index; everything else was validated above.
    return c.json({ error: "A document already exists at that path." }, 409);
  }
}

export async function getDocumentHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const document = await getDocument(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("documentId"),
  );
  return document ? c.json(document) : c.json({ error: "No such document." }, 404);
}

export async function updateDocumentHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid document body." }, 400);

  const updated = await updateDocumentBody(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("documentId"),
    { body: parsed.data.body, editedById: membershipIdOf(c, scope) },
  );
  return updated ? c.json(updated) : c.json({ error: "No such document." }, 404);
}

export async function deleteDocumentHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const removed = await deleteDocument(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("documentId"),
  );
  return removed ? c.body(null, 204) : c.json({ error: "No such document." }, 404);
}

export async function documentLinksHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const links = await getDocumentLinks(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("documentId"),
  );
  return c.json(links satisfies DocumentLinksPayload);
}
```

- [ ] **Step 4: Wire `index.md` and `log.md` maintenance**

Task 13's pure functions have no caller yet. The spec requires both files to be maintained automatically on every create and delete; without this step they are dead code and the bundle is not conformant.

Add to `knowledgeDocuments.ts` (the route file), and call `await maintainBundle(...)` at the end of `createDocumentHandler` and `deleteDocumentHandler`:

```ts
import { appendLogEntry, directoryOf, parentDirectories, renderIndex } from "../knowledge/bundle";
import { listDocuments, updateDocumentBody } from "../repositories/knowledgeDocuments";
import type { Db } from "../../db/client";
import type { CourseScope } from "../repositories/scope";

/** Regenerates the index documents a change invalidates, and appends one
 *  dated log line. Best-effort and deliberately after the response-shaping
 *  work: a failed housekeeping write should not fail an otherwise-good
 *  create, and the next change repairs it.
 *
 *  `isoDate` is passed in rather than read from the clock here, matching
 *  bundle.ts — the date is data, so the whole path stays testable. */
async function maintainBundle(
  db: Db,
  scope: CourseScope,
  changedPath: string,
  message: string,
  isoDate: string,
): Promise<void> {
  const documents = await listDocuments(db, scope);
  const byPath = new Map(documents.map((d) => [d.path, d]));

  // Only the ancestors of the changed path can have a stale listing.
  for (const directory of parentDirectories(changedPath)) {
    const indexPath = directory === "" ? "index" : `${directory}/index`;
    const indexDocument = byPath.get(indexPath);
    if (!indexDocument) continue;

    const entries = documents
      .filter((d) => d.kind === "concept" && directoryOf(d.path) === directory)
      .map((d) => ({ path: d.path, title: d.title, description: d.description }));

    await updateDocumentBody(db, scope, indexDocument.id, {
      body: renderIndex(directory, entries),
      editedById: null,
    });
  }

  const log = byPath.get("log");
  if (log) {
    const current = await getDocument(db, scope, log.id);
    await updateDocumentBody(db, scope, log.id, {
      body: appendLogEntry(current?.body ?? "", isoDate, message),
      editedById: null,
    });
  }
}
```

At the end of `createDocumentHandler`, before returning:

```ts
    await maintainBundle(
      db,
      scope,
      path,
      `**Creation** Added \`${path}\`.`,
      new Date().toISOString().slice(0, 10),
    );
```

and in `deleteDocumentHandler`, after a successful delete, the same call with `**Update** Removed \`${removed.path}\`.` — `deleteDocument` already returns `{ path }` (Task 6), so use that rather than re-reading the row.

Add these tests to `knowledgeDocuments.test.ts`:

```ts
it("regenerates the parent index after creating a concept", async () => {
  repo.listDocuments.mockResolvedValue([
    { id: "idx", path: "week1/index", kind: "index", title: null, description: null },
    { id: DOC_ID, path: "week1/a", kind: "concept", title: "A", description: "First." },
  ]);
  repo.updateDocumentBody.mockResolvedValue({ id: "idx" });

  await app().request(base, json({ path: "week1/a", kind: "concept", type: "note" }), TEST_ENV);

  expect(repo.updateDocumentBody).toHaveBeenCalledWith(
    expect.anything(),
    COURSE_ID,
    "idx",
    expect.objectContaining({ body: expect.stringContaining("* [A](/week1/a) - First.") }),
  );
});

it("does not fail a create when the bundle has no index document", async () => {
  repo.listDocuments.mockResolvedValue([]);
  const res = await app().request(base, json({ path: "a", kind: "concept", type: "note" }), TEST_ENV);
  expect(res.status).toBe(201);
});
```

- [ ] **Step 5: Run to verify it passes, then commit**

Run: `cd apps/web && npm test -- src/server/routes/knowledgeDocuments.test.ts && npm run typecheck`
Expected: PASS, 12 tests.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(api): knowledge document routes with OKF path validation (#42)


---

### Task 16: Collection routes and the resolve endpoint

**Files:**
- Create: `apps/web/src/server/routes/knowledgeCollections.ts`
- Test: `apps/web/src/server/routes/knowledgeCollections.test.ts`

**Interfaces:**
- Consumes: Task 7's repository.
- Produces: `listCollectionsHandler`, `createCollectionHandler`, `updateCollectionHandler`, `deleteCollectionHandler`, `setCollectionItemsHandler`, `listAttachmentsHandler`, `attachCollectionHandler`, `detachCollectionHandler`, `resolveKnowledgeHandler`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  attachCollectionHandler,
  createCollectionHandler,
  listCollectionsHandler,
  resolveKnowledgeHandler,
  setCollectionItemsHandler,
} from "./knowledgeCollections";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const COURSE_ID = "11111111-2222-4333-8444-555555555555";
const COL_ID = "33333333-2222-4333-8444-555555555555";
const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

const repo = {
  listCollections: vi.fn(),
  createCollection: vi.fn(),
  setCollectionItems: vi.fn(),
  attachCollection: vi.fn(),
  resolveForTarget: vi.fn(),
  listDocumentsInCollections: vi.fn(),
};

vi.mock("../repositories/knowledgeCollections", () => ({
  listCollections: (...a: unknown[]) => repo.listCollections(...a),
  createCollection: (...a: unknown[]) => repo.createCollection(...a),
  setCollectionItems: (...a: unknown[]) => repo.setCollectionItems(...a),
  attachCollection: (...a: unknown[]) => repo.attachCollection(...a),
  resolveForTarget: (...a: unknown[]) => repo.resolveForTarget(...a),
  listDocumentsInCollections: (...a: unknown[]) => repo.listDocumentsInCollections(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function app() {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set(
      "authContext",
      fakeAuthContext({
        memberships: [fakeMembership({ courseId: COURSE_ID, role: "instructor" })],
      }),
    );
    await next();
  });
  a.get("/api/courses/:courseId/knowledge/collections", listCollectionsHandler);
  a.post("/api/courses/:courseId/knowledge/collections", createCollectionHandler);
  a.put("/api/courses/:courseId/knowledge/collections/:collectionId/items", setCollectionItemsHandler);
  a.post("/api/courses/:courseId/knowledge/collections/:collectionId/attachments", attachCollectionHandler);
  a.get("/api/courses/:courseId/knowledge/resolve", resolveKnowledgeHandler);
  return a;
}

const base = `/api/courses/${COURSE_ID}/knowledge`;
const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  repo.listCollections.mockResolvedValue([]);
  repo.createCollection.mockResolvedValue({ id: COL_ID, name: "Week 1" });
  repo.setCollectionItems.mockResolvedValue(true);
  repo.attachCollection.mockResolvedValue(true);
  repo.resolveForTarget.mockResolvedValue({ level: "course", collectionIds: [COL_ID] });
  repo.listDocumentsInCollections.mockResolvedValue([
    { id: "d1", path: "a", indexStatus: "pending" },
  ]);
});

describe("collection routes", () => {
  it("lists collections", async () => {
    const res = await app().request(`${base}/collections`, {}, TEST_ENV);
    expect(await res.json()).toEqual({ collections: [] });
  });

  it("rejects a nameless collection", async () => {
    const res = await app().request(`${base}/collections`, json({ name: "" }), TEST_ENV);
    expect(res.status).toBe(400);
  });

  it("rejects an item naming both a document and a directory", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/items`,
      json({ items: [{ documentId: "d1", directoryPath: "wk" }] }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.setCollectionItems).not.toHaveBeenCalled();
  });

  it("accepts a mixed set of document and directory items", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/items`,
      json({ items: [{ documentId: "d1" }, { directoryPath: "wk" }] }, "PUT"),
      TEST_ENV,
    );
    expect(res.status).toBe(204);
  });

  it("rejects an attachment scope that names the wrong course", async () => {
    const res = await app().request(
      `${base}/collections/${COL_ID}/attachments`,
      json({ scope: { kind: "course", courseId: "99999999-2222-4333-8444-555555555555" } }),
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(repo.attachCollection).not.toHaveBeenCalled();
  });

  it("resolves and expands to documents", async () => {
    const res = await app().request(`${base}/resolve?homeworkId=hw-1`, {}, TEST_ENV);
    expect(await res.json()).toEqual({
      level: "course",
      collectionIds: [COL_ID],
      documents: [{ id: "d1", path: "a", indexStatus: "pending" }],
    });
  });

  it("returns an empty resolution without querying documents", async () => {
    repo.resolveForTarget.mockResolvedValue({ level: "none", collectionIds: [] });
    const res = await app().request(`${base}/resolve`, {}, TEST_ENV);
    expect(await res.json()).toEqual({ level: "none", collectionIds: [], documents: [] });
    expect(repo.listDocumentsInCollections).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npm test -- src/server/routes/knowledgeCollections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/* --------------------------------------------------------------------------
   Collections, attachments, and the resolve endpoint (#42).

   resolveKnowledgeHandler is the one worth reading twice. It answers "what
   will the tutor actually see here", and it exists so the override rule is
   VISIBLE in the console rather than something an instructor has to
   reconstruct from four attachment lists. It returns the deciding `level`
   alongside the collections, because "your section attachment silently
   replaced the course readings" is the failure mode of most-specific-wins
   and the UI needs to be able to say so.

   Retrieval (#41) will call resolveForTarget directly. Both paths go through
   the same pure function, so the console cannot show one answer while the
   tutor uses another.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import { z } from "zod";
import { makeDb } from "../../db/client";
import type { AppEnv } from "../context";
import { courseScopeFromAuthContext } from "../repositories/scope";
import {
  attachCollection,
  createCollection,
  deleteCollection,
  detachCollection,
  listAttachments,
  listCollections,
  listDocumentsInCollections,
  resolveForTarget,
  setCollectionItems,
  updateCollection,
} from "../repositories/knowledgeCollections";
import type {
  AttachmentListPayload,
  CollectionListPayload,
  ResolutionPayload,
} from "@llteacher/ui/api";

const writeSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
});

/** Exactly one target, mirroring the collection_items CHECK. A body naming
 *  both is a caller bug and is refused rather than silently preferring one. */
const itemSchema = z
  .object({
    documentId: z.string().uuid().optional(),
    directoryPath: z.string().min(1).max(400).optional(),
  })
  .refine((v) => !!v.documentId !== !!v.directoryPath, {
    message: "An item names exactly one of documentId or directoryPath.",
  });

const itemsSchema = z.object({ items: z.array(itemSchema).max(500) });

const scopeSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("course"), courseId: z.string().uuid() }),
    z.object({ kind: z.literal("homework"), homeworkId: z.string().uuid() }),
    z.object({ kind: z.literal("section"), sectionId: z.string().uuid() }),
    z.object({ kind: z.literal("llmConfig"), llmConfigId: z.string().uuid() }),
  ]),
});

function scopeOf(c: Context<AppEnv>) {
  const authContext = c.get("authContext");
  const courseId = c.req.param("courseId");
  return authContext ? courseScopeFromAuthContext(authContext, courseId) : null;
}

function membershipIdOf(c: Context<AppEnv>, courseId: string): string | null {
  return c.get("authContext")?.memberships.find((m) => m.courseId === courseId)?.id ?? null;
}

export async function listCollectionsHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const collections = await listCollections(makeDb(c.env.DATABASE_URL), scope);
  return c.json({ collections } satisfies CollectionListPayload);
}

export async function createCollectionHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "A collection needs a name." }, 400);

  const membershipId = membershipIdOf(c, scope);
  if (!membershipId) return c.json({ error: "Not permitted." }, 403);

  try {
    const created = await createCollection(makeDb(c.env.DATABASE_URL), scope, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      createdById: membershipId,
    });
    return c.json(created, 201);
  } catch {
    return c.json({ error: "A collection with that name already exists." }, 409);
  }
}

export async function updateCollectionHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const parsed = writeSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid collection." }, 400);

  const updated = await updateCollection(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("collectionId"),
    parsed.data,
  );
  return updated ? c.json(updated) : c.json({ error: "No such collection." }, 404);
}

export async function deleteCollectionHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const removed = await deleteCollection(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("collectionId"),
  );
  return removed ? c.body(null, 204) : c.json({ error: "No such collection." }, 404);
}

export async function setCollectionItemsHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const parsed = itemsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Each item names exactly one of documentId or directoryPath." }, 400);
  }

  const ok = await setCollectionItems(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("collectionId"),
    parsed.data.items as Parameters<typeof setCollectionItems>[3],
  );
  return ok ? c.body(null, 204) : c.json({ error: "No such collection." }, 404);
}

export async function listAttachmentsHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const attachments = await listAttachments(makeDb(c.env.DATABASE_URL), scope);
  return c.json({ attachments } satisfies AttachmentListPayload);
}

export async function attachCollectionHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const parsed = scopeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid attachment scope." }, 400);
  const attachmentScope = parsed.data.scope;

  // A course-scoped attachment may only name THIS course. Without this the
  // scope column would be a caller-supplied course id that the tenancy guard
  // on course_id never sees.
  if (attachmentScope.kind === "course" && attachmentScope.courseId !== scope) {
    return c.json({ error: "A course attachment must name this course." }, 400);
  }

  const ok = await attachCollection(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("collectionId"),
    attachmentScope,
  );
  return ok ? c.body(null, 204) : c.json({ error: "No such collection." }, 404);
}

export async function detachCollectionHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const ok = await detachCollection(
    makeDb(c.env.DATABASE_URL),
    scope,
    c.req.param("attachmentId"),
  );
  return ok ? c.body(null, 204) : c.json({ error: "No such attachment." }, 404);
}

export async function resolveKnowledgeHandler(c: Context<AppEnv>) {
  const scope = scopeOf(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const resolution = await resolveForTarget(db, scope, {
    courseId: scope,
    homeworkId: c.req.query("homeworkId") ?? null,
    sectionId: c.req.query("sectionId") ?? null,
    llmConfigId: c.req.query("llmConfigId") ?? null,
  });

  // No attachments means no documents; skip the expansion query entirely.
  const documents =
    resolution.collectionIds.length === 0
      ? []
      : await listDocumentsInCollections(db, scope, resolution.collectionIds);

  return c.json({ ...resolution, documents } as ResolutionPayload);
}
```

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd apps/web && npm test -- src/server/routes/knowledgeCollections.test.ts && npm run typecheck`
Expected: PASS, 7 tests.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(api): collection CRUD, attachments, and the resolve endpoint (#42)


---

### Task 17: Register the routes and gate Phase 2

**Files:**
- Modify: `apps/web/src/server/index.ts` (after the LLM-config block, ~line 318)

**Interfaces:**
- Consumes: every handler from Tasks 14–16.
- Produces: the live API surface Phase 3 calls.

- [ ] **Step 1: Register every route**

```ts
// ---- Knowledge management (#42) ----
// All instructor-of-course, all nested under :courseId so requireInstructorOf
// guards tenancy straight from the path.
app.get("/api/courses/:courseId/materials", requireInstructorOf()(listMaterialsHandler));
app.post("/api/courses/:courseId/materials", requireInstructorOf()(uploadMaterialHandler));
app.delete(
  "/api/courses/:courseId/materials/:materialId",
  requireInstructorOf()(deleteMaterialHandler),
);
app.post(
  "/api/courses/:courseId/materials/:materialId/reingest",
  requireInstructorOf()(reingestMaterialHandler),
);

app.get(
  "/api/courses/:courseId/knowledge/documents",
  requireInstructorOf()(listDocumentsHandler),
);
app.post(
  "/api/courses/:courseId/knowledge/documents",
  requireInstructorOf()(createDocumentHandler),
);
app.get(
  "/api/courses/:courseId/knowledge/documents/:documentId",
  requireInstructorOf()(getDocumentHandler),
);
app.put(
  "/api/courses/:courseId/knowledge/documents/:documentId",
  requireInstructorOf()(updateDocumentHandler),
);
app.delete(
  "/api/courses/:courseId/knowledge/documents/:documentId",
  requireInstructorOf()(deleteDocumentHandler),
);
app.get(
  "/api/courses/:courseId/knowledge/documents/:documentId/links",
  requireInstructorOf()(documentLinksHandler),
);

app.get(
  "/api/courses/:courseId/knowledge/collections",
  requireInstructorOf()(listCollectionsHandler),
);
app.post(
  "/api/courses/:courseId/knowledge/collections",
  requireInstructorOf()(createCollectionHandler),
);
app.patch(
  "/api/courses/:courseId/knowledge/collections/:collectionId",
  requireInstructorOf()(updateCollectionHandler),
);
app.delete(
  "/api/courses/:courseId/knowledge/collections/:collectionId",
  requireInstructorOf()(deleteCollectionHandler),
);
app.put(
  "/api/courses/:courseId/knowledge/collections/:collectionId/items",
  requireInstructorOf()(setCollectionItemsHandler),
);
app.get(
  "/api/courses/:courseId/knowledge/attachments",
  requireInstructorOf()(listAttachmentsHandler),
);
app.post(
  "/api/courses/:courseId/knowledge/collections/:collectionId/attachments",
  requireInstructorOf()(attachCollectionHandler),
);
app.delete(
  "/api/courses/:courseId/knowledge/attachments/:attachmentId",
  requireInstructorOf()(detachCollectionHandler),
);
app.get("/api/courses/:courseId/knowledge/resolve", requireInstructorOf()(resolveKnowledgeHandler));
```

Add the matching imports at the top, following the existing import grouping.

- [ ] **Step 2: Run the full suite**

Run from the repo root: `npm run typecheck && npm run test`
Expected: PASS everywhere.

- [ ] **Step 3: Smoke-test the API by hand**

```bash
cd apps/web && npm run dev
# In another shell, with a logged-in session cookie in $COOKIE and $COURSE set:
curl -s -b "$COOKIE" localhost:5173/api/courses/$COURSE/knowledge/documents
curl -s -b "$COOKIE" -F "file=@lecture1.vtt" localhost:5173/api/courses/$COURSE/materials
curl -s -b "$COOKIE" localhost:5173/api/courses/$COURSE/knowledge/documents
```

Expected: the third call lists a `transcript` document created from the upload, with `indexStatus: "pending"`.

- [ ] **Step 4: Commit and open the PR**

Invoke the `/commit` skill. Suggested message:

> feat(api): register knowledge management routes (#42)

Then invoke the `/create-pr` skill. Suggested title and body:

> **M-KM PR2: knowledge storage, ingestion, and API (#42)**
>
> Phase 2 of docs/superpowers/specs/2026-09-09-knowledge-management-design.md. R2-backed ObjectStore, tier-1 transcript/markdown conversion, OKF index.md and log.md maintenance, and the full route surface including /knowledge/resolve. No UI yet.

---

# Phase 3 — The console (PR 3)

Five views plus homework-form integration. Ends with #42's acceptance criteria met, per-assignment rather than per-course.

Views follow the existing pattern (`TaCapabilitiesView.tsx`): the view owns its own load via `useApiResource`, tests stub `fetch` with `vi.stubGlobal`, and loading/error sentences are announced through a permanently-mounted `role="status"` region rather than an inserted one.

---

### Task 18: Client plumbing — api-client, RecordId, sidebar

**Files:**
- Modify: `apps/admin/src/client/lib/api-client.ts` (append to the `apiClient` object)
- Modify: `apps/admin/src/client/components/RecordId.tsx:14`
- Modify: `apps/admin/src/client/components/AdminSidebar.tsx:57` (the `AdminNavKey` union and `NAV_ITEMS`)
- Test: `apps/admin/src/client/lib/api-client.test.ts` (exists — append)

**Interfaces:**
- Consumes: the wire types from Task 11.
- Produces: `apiClient.knowledge.*`, `RecordId` prefixes `"DOC" | "COL"`, `AdminNavKey` member `"knowledge"`. Tasks 19–23 consume all three.

- [ ] **Step 1: Write the failing test**

Append to `api-client.test.ts`:

```ts
import { apiClient } from "./api-client";

describe("apiClient.knowledge", () => {
  it("lists documents under the course path", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ documents: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.knowledge.listDocuments("c1", { signal: null });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/courses/c1/knowledge/documents");
  });

  it("sends an upload as multipart without a JSON content-type", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "m1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["hi"], "a.txt", { type: "text/plain" });
    await apiClient.knowledge.uploadMaterial("c1", file, { signal: null });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    // Letting the browser set the multipart boundary is the point: an
    // explicit content-type here produces a body the server cannot parse.
    expect(new Headers(init.headers).get("content-type")).toBeNull();
  });

  it("encodes ids into the resolve query rather than the path", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ level: "none", collectionIds: [], documents: [] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.knowledge.resolve("c1", { homeworkId: "hw 1" }, { signal: null });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/courses/c1/knowledge/resolve?homeworkId=hw+1",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/admin && npm test -- src/client/lib/api-client.test.ts`
Expected: FAIL — `apiClient.knowledge` is undefined.

- [ ] **Step 3: Implement**

Append to the `apiClient` object in `api-client.ts`:

```ts
  knowledge: {
    listMaterials: (courseId: string, opts: RequestOptions) =>
      request<MaterialListPayload>(
        `/api/courses/${encode(courseId)}/materials`,
        { method: "GET" },
        opts,
      ),
    /** Multipart, and deliberately without a content-type header: the
     *  browser must set the multipart boundary itself, and an explicit
     *  header here produces a body the server cannot parse. `request`
     *  skips its JSON default when the body is FormData. */
    uploadMaterial: (courseId: string, file: File, opts: RequestOptions) => {
      const form = new FormData();
      form.set("file", file);
      return request<{ id: string; status: MaterialStatus }>(
        `/api/courses/${encode(courseId)}/materials`,
        { method: "POST", body: form },
        opts,
      );
    },
    deleteMaterial: (courseId: string, materialId: string, opts: RequestOptions) =>
      request<null>(
        `/api/courses/${encode(courseId)}/materials/${encode(materialId)}`,
        { method: "DELETE" },
        opts,
      ),
    /** Re-runs tier-1 conversion server-side. Honest about the no-op case: for a
     *  format the pipeline still cannot extract, the response comes back
     *  `pending` with `documentCreated: false` rather than pretending it worked. */
    reingestMaterial: (courseId: string, materialId: string, opts: RequestOptions) =>
      request<{ status: MaterialStatus; documentCreated: boolean }>(
        `/api/courses/${encode(courseId)}/materials/${encode(materialId)}/reingest`,
        { method: "POST" },
        opts,
      ),

    listDocuments: (courseId: string, opts: RequestOptions) =>
      request<KnowledgeDocumentListPayload>(
        `/api/courses/${encode(courseId)}/knowledge/documents`,
        { method: "GET" },
        opts,
      ),
    getDocument: (courseId: string, documentId: string, opts: RequestOptions) =>
      request<KnowledgeDocumentPayload>(
        `/api/courses/${encode(courseId)}/knowledge/documents/${encode(documentId)}`,
        { method: "GET" },
        opts,
      ),
    createDocument: (
      courseId: string,
      body: { path: string; kind: "concept" | "index"; type?: string; title?: string; body?: string },
      opts: RequestOptions,
    ) =>
      request<KnowledgeDocumentPayload>(
        `/api/courses/${encode(courseId)}/knowledge/documents`,
        { method: "POST", body: JSON.stringify(body) },
        opts,
      ),
    updateDocument: (
      courseId: string,
      documentId: string,
      body: { body: string },
      opts: RequestOptions,
    ) =>
      request<KnowledgeDocumentPayload>(
        `/api/courses/${encode(courseId)}/knowledge/documents/${encode(documentId)}`,
        { method: "PUT", body: JSON.stringify(body) },
        opts,
      ),
    deleteDocument: (courseId: string, documentId: string, opts: RequestOptions) =>
      request<null>(
        `/api/courses/${encode(courseId)}/knowledge/documents/${encode(documentId)}`,
        { method: "DELETE" },
        opts,
      ),
    documentLinks: (courseId: string, documentId: string, opts: RequestOptions) =>
      request<DocumentLinksPayload>(
        `/api/courses/${encode(courseId)}/knowledge/documents/${encode(documentId)}/links`,
        { method: "GET" },
        opts,
      ),

    listCollections: (courseId: string, opts: RequestOptions) =>
      request<CollectionListPayload>(
        `/api/courses/${encode(courseId)}/knowledge/collections`,
        { method: "GET" },
        opts,
      ),
    createCollection: (courseId: string, body: CollectionWriteBody, opts: RequestOptions) =>
      request<CollectionPayload>(
        `/api/courses/${encode(courseId)}/knowledge/collections`,
        { method: "POST", body: JSON.stringify(body) },
        opts,
      ),
    deleteCollection: (courseId: string, collectionId: string, opts: RequestOptions) =>
      request<null>(
        `/api/courses/${encode(courseId)}/knowledge/collections/${encode(collectionId)}`,
        { method: "DELETE" },
        opts,
      ),
    setCollectionItems: (
      courseId: string,
      collectionId: string,
      items: CollectionItemBody[],
      opts: RequestOptions,
    ) =>
      request<null>(
        `/api/courses/${encode(courseId)}/knowledge/collections/${encode(collectionId)}/items`,
        { method: "PUT", body: JSON.stringify({ items }) },
        opts,
      ),

    listAttachments: (courseId: string, opts: RequestOptions) =>
      request<AttachmentListPayload>(
        `/api/courses/${encode(courseId)}/knowledge/attachments`,
        { method: "GET" },
        opts,
      ),
    attach: (
      courseId: string,
      collectionId: string,
      scope: AttachmentScopePayload,
      opts: RequestOptions,
    ) =>
      request<null>(
        `/api/courses/${encode(courseId)}/knowledge/collections/${encode(collectionId)}/attachments`,
        { method: "POST", body: JSON.stringify({ scope }) },
        opts,
      ),
    detach: (courseId: string, attachmentId: string, opts: RequestOptions) =>
      request<null>(
        `/api/courses/${encode(courseId)}/knowledge/attachments/${encode(attachmentId)}`,
        { method: "DELETE" },
        opts,
      ),

    /** Query params, not path segments: every id here is optional, and a
     *  path with holes in it is not a path. */
    resolve: (
      courseId: string,
      target: { homeworkId?: string; sectionId?: string; llmConfigId?: string },
      opts: RequestOptions,
    ) => {
      const query = new URLSearchParams(
        Object.entries(target).filter(([, v]) => !!v) as [string, string][],
      );
      const suffix = query.toString() ? `?${query}` : "";
      return request<ResolutionPayload>(
        `/api/courses/${encode(courseId)}/knowledge/resolve${suffix}`,
        { method: "GET" },
        opts,
      );
    },
  },
```

In `request()`, the headers block currently reads (api-client.ts, inside the `fetch` call):

```ts
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
```

A `FormData` body is truthy, so this stamps `application/json` on the upload and
the server cannot parse the multipart boundary. Change exactly that one line:

```ts
      headers: {
        // A FormData body carries its own multipart content-type INCLUDING the
        // boundary, which only the browser can generate. Stamping JSON here
        // produced a body the Worker could not parse (#42).
        ...(init.body && !(init.body instanceof FormData)
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
```

Add the imports for every payload type used above.

- [ ] **Step 4: Extend `RecordId` and the sidebar**

`RecordId.tsx:14`:

```ts
  prefix: "HW" | "CFG" | "STU" | "SEC" | "DOC" | "COL";
```

`AdminSidebar.tsx` — add `"knowledge"` to `AdminNavKey` and this entry to `NAV_ITEMS`, after `llm-configs`:

```tsx
  { key: "knowledge", label: "Knowledge", icon: <Books size={15} weight="regular" />, description: "Materials and collections", authorOnly: true },
```

Import `Books` from `@phosphor-icons/react`. `authorOnly: true` matters: a TA may read the console but not author in it, and #172's audit found that rendering an entry whose endpoint 403s is the precise defect that flag exists to prevent.

- [ ] **Step 5: Run tests and commit**

Run: `cd apps/admin && npm test && npm run typecheck`
Expected: PASS, including the existing `AdminSidebar.test.tsx`.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(admin): knowledge api-client, DOC/COL record ids, sidebar entry (#42)


---

### Task 19: `KnowledgeView` — the bundle browser

**Files:**
- Create: `apps/admin/src/client/views/KnowledgeView.tsx`
- Create: `apps/admin/src/client/views/KnowledgeView.test.tsx`
- Create: `apps/admin/src/client/lib/documentTree.ts`
- Create: `apps/admin/src/client/lib/documentTree.test.ts`

**Interfaces:**
- Consumes: `apiClient.knowledge.listDocuments/listMaterials/uploadMaterial`, `useApiResource`, `PageHeader`, `RecordId`, `StatusBadge`.
- Produces: `KnowledgeView({ courseId, onOpenDocument })`, and `buildTree(paths)` / `directoriesOf(paths)` from `documentTree.ts` — Task 21's collection picker reuses both.

Tree derivation is pulled into its own module because two views need it and because a pure function is far easier to pin down than a rendered tree.

- [ ] **Step 1: Write the failing test for the tree helper**

```ts
import { describe, it, expect } from "vitest";
import { directoriesOf, documentsIn } from "./documentTree";

const DOCS = [
  { id: "1", path: "index", kind: "index" as const },
  { id: "2", path: "week1/index", kind: "index" as const },
  { id: "3", path: "week1/lecture", kind: "concept" as const },
  { id: "4", path: "week1/lab/notes", kind: "concept" as const },
  { id: "5", path: "syllabus", kind: "concept" as const },
];

describe("directoriesOf", () => {
  it("derives every directory from paths, root first", () => {
    expect(directoriesOf(DOCS)).toEqual(["", "week1", "week1/lab"]);
  });

  it("returns just the root for a flat bundle", () => {
    expect(directoriesOf([{ id: "1", path: "a", kind: "concept" }])).toEqual([""]);
  });
});

describe("documentsIn", () => {
  it("lists a directory's own concepts, not its descendants'", () => {
    expect(documentsIn(DOCS, "week1").map((d) => d.path)).toEqual(["week1/lecture"]);
  });

  it("lists root concepts", () => {
    expect(documentsIn(DOCS, "").map((d) => d.path)).toEqual(["syllabus"]);
  });

  it("hides index and log documents — they are structure, not content", () => {
    expect(documentsIn(DOCS, "week1").every((d) => d.kind === "concept")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/admin && npm test -- src/client/lib/documentTree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tree helper**

```ts
/* --------------------------------------------------------------------------
   Deriving a folder tree from OKF paths (#42).

   There is no directory table: OKF has no directory entity, and paths ARE
   identity. So the tree is a projection of the path list, computed here
   rather than in two views that would drift.

   index and log documents are structure, not content -- they are what makes
   an empty folder exist and what carries the change history -- so a
   directory listing shows concepts only.
   -------------------------------------------------------------------------- */

export interface TreeDocument {
  id: string;
  path: string;
  kind: "concept" | "index" | "log";
}

export function directoryOf(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

/** Every directory in the bundle, root ("") first, then depth-first by name.
 *  Derived from both concepts and index documents, so a folder created but
 *  not yet filled still appears. */
export function directoriesOf(documents: readonly TreeDocument[]): string[] {
  const directories = new Set<string>([""]);
  for (const document of documents) {
    const segments = document.path.split("/").slice(0, -1);
    for (let i = 0; i < segments.length; i++) {
      directories.add(segments.slice(0, i + 1).join("/"));
    }
  }
  return [...directories].sort();
}

/** The concepts directly inside one directory — not its subdirectories'. */
export function documentsIn(
  documents: readonly TreeDocument[],
  directory: string,
): TreeDocument[] {
  return documents
    .filter((d) => d.kind === "concept" && directoryOf(d.path) === directory)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function depthOf(directory: string): number {
  return directory === "" ? 0 : directory.split("/").length;
}

export function nameOf(directory: string): string {
  return directory === "" ? "Knowledge base" : (directory.split("/").pop() ?? directory);
}
```

Also create `apps/admin/src/client/lib/knowledgeStatus.ts` — the knowledge views
render statuses `StatusBadge` has never seen:

```ts
/* --------------------------------------------------------------------------
   Knowledge statuses as StatusBadge kinds (#42).

   StatusBadge's `kind` is a closed union driving one CSS class each, and none
   of its members are `pending`/`ready`/`indexed`. Mapping onto the existing
   kinds rather than widening the union keeps a shared component free of a new
   domain's vocabulary and needs no new CSS -- and costs nothing legible,
   because the exact status word is the badge's visible text either way.
   -------------------------------------------------------------------------- */

import type { StatusKind } from "../components/StatusBadge";
import type { KnowledgeIndexStatus, MaterialStatus } from "@llteacher/ui/api";

const KIND: Record<MaterialStatus | KnowledgeIndexStatus, StatusKind> = {
  pending: "scheduled",
  processing: "in_progress",
  ready: "active",
  indexed: "active",
  failed: "missing",
};

const LABEL: Record<MaterialStatus | KnowledgeIndexStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  indexed: "Indexed",
  failed: "Failed",
};

export function statusKind(status: MaterialStatus | KnowledgeIndexStatus): StatusKind {
  return KIND[status];
}

export function statusLabel(status: MaterialStatus | KnowledgeIndexStatus): string {
  return LABEL[status];
}
```

with tests:

```ts
import { describe, it, expect } from "vitest";
import { statusKind, statusLabel } from "./knowledgeStatus";

describe("knowledgeStatus", () => {
  it.each([
    ["pending", "scheduled", "Pending"],
    ["processing", "in_progress", "Processing"],
    ["ready", "active", "Ready"],
    ["indexed", "active", "Indexed"],
    ["failed", "missing", "Failed"],
  ] as const)("maps %s to kind %s labelled %s", (status, kind, label) => {
    expect(statusKind(status)).toBe(kind);
    expect(statusLabel(status)).toBe(label);
  });
});
```

- [ ] **Step 4: Run the helper test**

Run: `cd apps/admin && npm test -- src/client/lib/documentTree.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing view test**

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { KnowledgeView } from "./KnowledgeView";

afterEach(cleanup);

const DOCUMENTS = [
  { id: "d1", path: "week1/lecture", kind: "concept", type: "transcript", title: "Lecture 1", description: "Intro", tags: null, indexStatus: "pending", sourceMaterialId: "m1", updatedAt: "2026-09-01T00:00:00.000Z" },
  { id: "d2", path: "syllabus", kind: "concept", type: "syllabus", title: "Syllabus", description: null, tags: null, indexStatus: "indexed", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z" },
];

const MATERIALS = [
  { id: "m1", title: "lecture1", sourceType: "transcript", originalFilename: "lecture1.vtt", byteSize: 100, contentType: "text/vtt", status: "ready", errorDetail: null, uploadedAt: "2026-09-01T00:00:00.000Z" },
  { id: "m2", title: "paper", sourceType: "pdf", originalFilename: "paper.pdf", byteSize: 100, contentType: "application/pdf", status: "pending", errorDetail: "Text extraction for .pdf is not implemented yet (#40).", uploadedAt: "2026-09-01T00:00:00.000Z" },
];

function stubFetch(overrides: Record<string, unknown> = {}) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/knowledge/documents")) {
      return new Response(JSON.stringify(overrides.documents ?? { documents: DOCUMENTS }), { status: 200 });
    }
    if (url.includes("/reingest")) {
      return new Response(JSON.stringify({ status: "pending", documentCreated: false }), { status: 200 });
    }
    if (url.includes("/materials")) {
      return new Response(JSON.stringify(overrides.materials ?? { materials: MATERIALS }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("KnowledgeView", () => {
  it("renders the directory tree derived from paths", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByRole("button", { name: /week1/ }));
    expect(screen.getByRole("button", { name: /Knowledge base/ })).toBeTruthy();
  });

  it("shows root documents first and switches on directory click", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));
    expect(screen.queryByText("Lecture 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /week1/ }));
    await waitFor(() => screen.getByText("Lecture 1"));
  });

  it("shows a pending material's error detail rather than claiming it is ready", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText(/not implemented yet/i));
  });

  it("shows an empty state for a course with no documents", async () => {
    stubFetch({ documents: { documents: [] }, materials: { materials: [] } });
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText(/No documents yet/i));
  });

  it("rejects a disallowed file before uploading it", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    const bad = new File(["MZ"], "evil.exe", { type: "application/octet-stream" });
    fireEvent.change(input, { target: { files: [bad] } });

    await waitFor(() => screen.getByText(/Unsupported file type/i));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/materials")).length).toBe(1);
  });

  it("offers a retry only for materials that are not ready", async () => {
    stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    // MATERIALS[1] is the pending PDF; MATERIALS[0] is the ready transcript.
    expect(screen.getByLabelText(/Retry ingestion for paper\.pdf/)).toBeTruthy();
    expect(screen.queryByLabelText(/Retry ingestion for lecture1\.vtt/)).toBeNull();
  });

  it("posts a reingest when retry is pressed", async () => {
    const fetchMock = stubFetch();
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() => screen.getByText("Syllabus"));

    fireEvent.click(screen.getByLabelText(/Retry ingestion for paper\.pdf/));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u, i]) =>
          String(u).endsWith("/materials/m2/reingest") && (i as RequestInit)?.method === "POST",
        ),
      ).toBe(true),
    );
  });

  it("opens a document when its row is clicked", async () => {
    stubFetch();
    const onOpenDocument = vi.fn();
    render(<KnowledgeView courseId="c1" onOpenDocument={onOpenDocument} />);
    await waitFor(() => screen.getByText("Syllabus"));

    fireEvent.click(screen.getByText("Syllabus"));
    expect(onOpenDocument).toHaveBeenCalledWith("d2");
  });

  it("surfaces a load failure instead of an empty bundle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(/Failed to load/i),
    );
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd apps/admin && npm test -- src/client/views/KnowledgeView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement the view**

```tsx
/* --------------------------------------------------------------------------
   KnowledgeView — the course's OKF bundle, browsable (#42).

   Two panes: a directory rail derived from document paths (there is no
   directory table -- see lib/documentTree.ts) and the selected directory's
   concepts.

   The materials strip below the listing is where the honest-status rule
   becomes visible: a PDF sits at `pending` with the reason showing, because
   #40's extraction pipeline does not exist yet. It is not marked ready and
   it is not hidden. An instructor who needs that PDF grounded can author a
   document against it by hand, which is the escape hatch that makes the
   un-extractable tier usable before #40 lands.
   -------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { FolderOpen, UploadSimple } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { StatusBadge } from "../components/StatusBadge";
import { ViewLoading, ViewError, ViewEmpty } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { depthOf, directoriesOf, documentsIn, nameOf } from "../lib/documentTree";
import { statusKind, statusLabel } from "../lib/knowledgeStatus";
import type {
  KnowledgeDocumentListPayload,
  MaterialListPayload,
} from "@llteacher/ui/api";

const ALLOWED_EXTENSIONS = ["pdf", "docx", "pptx", "txt", "md", "vtt", "srt"];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type KnowledgeViewProps = {
  courseId: string;
  onOpenDocument: (documentId: string) => void;
};

export function KnowledgeView({ courseId, onOpenDocument }: KnowledgeViewProps) {
  const [directory, setDirectory] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const documents = useApiResource<KnowledgeDocumentListPayload>(
    (opts) => apiClient.knowledge.listDocuments(courseId, opts),
    [courseId],
    { announce: setAnnouncement, loadingMessage: "Loading knowledge base…" },
  );
  const materials = useApiResource<MaterialListPayload>(
    (opts) => apiClient.knowledge.listMaterials(courseId, opts),
    [courseId],
  );

  const all = documents.data?.documents ?? [];
  const directories = useMemo(() => directoriesOf(all), [all]);
  const visible = useMemo(() => documentsIn(all, directory), [all, directory]);

  /** Client-side validation is for a fast error only; the server re-checks
   *  both of these and is the authority. */
  async function handleFile(file: File | undefined) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      setUploadError(
        `Unsupported file type ".${extension}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`,
      );
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError("File is larger than the 25 MB limit.");
      return;
    }
    setUploadError(null);
    await apiClient.knowledge.uploadMaterial(courseId, file, { signal: null });
    documents.reload();
    materials.reload();
  }

  /* #42: the retry affordance for a material the pipeline could not extract.
     It is honest about the no-op: re-running tier-1 conversion on a PDF comes
     back `pending` again, and the material's own error_detail keeps saying why,
     rather than the button implying the next press might differ. */
  async function retry(materialId: string) {
    await apiClient.knowledge.reingestMaterial(courseId, materialId, { signal: null });
    materials.reload();
    documents.reload();
  }

  return (
    <div className="admin-view">
      <div className="admin-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>

      <PageHeader
        eyebrow={`KNOWLEDGE · ${all.length} DOCUMENTS`}
        title="Knowledge base"
        subtitle="Uploaded materials become OKF documents. Group them into collections to ground an assignment."
        actions={
          <label className="admin-button admin-button--primary">
            <UploadSimple size={15} /> Upload material
            <input
              type="file"
              aria-label="Upload material"
              className="admin-visually-hidden"
              accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")}
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
          </label>
        }
      />

      {uploadError && <p className="admin-inline-error">{uploadError}</p>}

      {documents.loading && <ViewLoading label="Loading knowledge base…" />}
      {documents.error && (
        <ViewError
          message="Failed to load the knowledge base."
          onRetry={documents.canRetry ? documents.reload : undefined}
        />
      )}

      {documents.data && (
        <div className="admin-knowledge">
          <nav className="admin-knowledge__tree" aria-label="Folders">
            {directories.map((dir) => (
              <button
                key={dir || "root"}
                type="button"
                className={
                  dir === directory
                    ? "admin-knowledge__folder admin-knowledge__folder--active"
                    : "admin-knowledge__folder"
                }
                style={{ paddingLeft: `${8 + depthOf(dir) * 14}px` }}
                onClick={() => setDirectory(dir)}
              >
                <FolderOpen size={14} /> {nameOf(dir)}
              </button>
            ))}
          </nav>

          <div className="admin-knowledge__listing">
            {visible.length === 0 ? (
              <ViewEmpty message="No documents yet in this folder." />
            ) : (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Title</th>
                    <th>Type</th>
                    <th>Indexing</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((document, i) => (
                    <tr key={document.id} onClick={() => onOpenDocument(document.id)}>
                      <td>
                        <RecordId prefix="DOC" index={i + 1} size="sm" />
                      </td>
                      <td>{document.title ?? document.path}</td>
                      <td>{document.type}</td>
                      <td>
                        <StatusBadge kind={statusKind(document.indexStatus)}>{statusLabel(document.indexStatus)}</StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {(materials.data?.materials.length ?? 0) > 0 && (
        <section className="admin-knowledge__materials">
          <h2>Uploaded files</h2>
          <ul>
            {materials.data!.materials.map((material) => (
              <li key={material.id}>
                <span>{material.originalFilename}</span>
                <StatusBadge kind={statusKind(material.status)}>{statusLabel(material.status)}</StatusBadge>
                {material.errorDetail && (
                  <span className="admin-knowledge__material-note">{material.errorDetail}</span>
                )}
                {(material.status === "pending" || material.status === "failed") && (
                  <button
                    type="button"
                    onClick={() => void retry(material.id)}
                    aria-label={`Retry ingestion for ${material.originalFilename}`}
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
```

If `ViewLoading` / `ViewError` / `ViewEmpty` have different names in `components/ViewState.tsx`, use the actual exports — do not add new ones.

Add the CSS for `.admin-knowledge*` to the `ADMIN CONSOLE` block in `packages/ui/styles.css`, following the convention recorded in `docs/architecture/admin-console.md` (admin styles live in the shared package so a future move into `packages/ui` is a TypeScript-only change).

- [ ] **Step 8: Run to verify it passes, then commit**

Run: `cd apps/admin && npm test -- src/client/views/KnowledgeView.test.tsx && npm run typecheck`
Expected: PASS, 9 tests.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(admin): knowledge bundle browser with folder tree (#42)


---

### Task 20: `KnowledgeDocumentView` — editor and link panel

**Files:**
- Create: `apps/admin/src/client/views/KnowledgeDocumentView.tsx`
- Create: `apps/admin/src/client/views/KnowledgeDocumentView.test.tsx`

**Interfaces:**
- Consumes: `apiClient.knowledge.getDocument/updateDocument/documentLinks`.
- Produces: `KnowledgeDocumentView({ courseId, documentId, onBack })`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { KnowledgeDocumentView } from "./KnowledgeDocumentView";

afterEach(cleanup);

const DOCUMENT = {
  id: "d1",
  path: "week1/lecture",
  kind: "concept",
  type: "transcript",
  title: "Lecture 1",
  description: "Intro",
  tags: null,
  indexStatus: "pending",
  sourceMaterialId: "m1",
  updatedAt: "2026-09-01T00:00:00.000Z",
  body: "Welcome to lecture one. See [lab](/week1/lab/notes).",
  bodyOriginal: "Welcome to lecture one.",
  frontmatter: null,
  editedAt: null,
};

const LINKS = {
  outbound: [
    { rawHref: "/week1/lab/notes", targetPath: "week1/lab/notes", resolvedDocumentId: "d2", isBroken: false },
    { rawHref: "/gone", targetPath: "gone", resolvedDocumentId: null, isBroken: true },
  ],
  backlinks: [{ sourceDocumentId: "d3", sourcePath: "syllabus" }],
};

function stubFetch(onPut?: (body: unknown) => void) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      onPut?.(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ...DOCUMENT, body: "edited" }), { status: 200 });
    }
    if (url.endsWith("/links")) return new Response(JSON.stringify(LINKS), { status: 200 });
    return new Response(JSON.stringify(DOCUMENT), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("KnowledgeDocumentView", () => {
  it("renders the document's frontmatter and body", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByDisplayValue(/Welcome to lecture one/));
    expect(screen.getByText("week1/lecture")).toBeTruthy();
    expect(screen.getByText("transcript")).toBeTruthy();
  });

  it("flags a broken link rather than hiding it", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText("/gone"));
    expect(screen.getByText(/broken/i)).toBeTruthy();
  });

  it("lists backlinks", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByText("syllabus"));
  });

  it("saves an edited body", async () => {
    const saved = vi.fn();
    stubFetch(saved);
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "edited" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ body: "edited" }));
  });

  it("warns that saving re-queues indexing", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "changed" } });
    await waitFor(() => screen.getByText(/re-indexed/i));
  });

  it("reverts to the extracted text", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    const editor = (await screen.findByLabelText(/document body/i)) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "mangled" } });
    fireEvent.click(screen.getByRole("button", { name: /revert to extraction/i }));

    await waitFor(() => expect(editor.value).toBe("Welcome to lecture one."));
  });

  it("toggles a rendered preview", async () => {
    stubFetch();
    render(<KnowledgeDocumentView courseId="c1" documentId="d1" onBack={vi.fn()} />);
    await screen.findByLabelText(/document body/i);
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(screen.queryByLabelText(/document body/i)).toBeNull());
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/admin && npm test -- src/client/views/KnowledgeDocumentView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
/* --------------------------------------------------------------------------
   KnowledgeDocumentView — one OKF concept (#42).

   The links panel is the reason this view exists rather than a modal. OKF
   relationships are ordinary markdown links, and the spec says consumers
   "MUST tolerate broken links" -- tolerating is not hiding. An instructor
   who renames a document needs to see what it broke, so broken links are
   listed and marked rather than filtered out.

   Editing is the escape hatch for formats #40 cannot extract yet: an
   instructor can write the markdown by hand and the document becomes real
   grounding material with no model involved. Saving resets index_status to
   pending, which the copy says out loud -- a silent re-queue would leave
   someone wondering why their edit had not taken effect.
   -------------------------------------------------------------------------- */

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, LinkBreak, LinkSimple } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { ViewError, ViewLoading } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { statusKind, statusLabel } from "../lib/knowledgeStatus";
import type { DocumentLinksPayload, KnowledgeDocumentPayload } from "@llteacher/ui/api";

export type KnowledgeDocumentViewProps = {
  courseId: string;
  documentId: string;
  onBack: () => void;
};

export function KnowledgeDocumentView({
  courseId,
  documentId,
  onBack,
}: KnowledgeDocumentViewProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const document = useApiResource<KnowledgeDocumentPayload>(
    (opts) => apiClient.knowledge.getDocument(courseId, documentId, opts),
    [courseId, documentId],
  );
  const links = useApiResource<DocumentLinksPayload>(
    (opts) => apiClient.knowledge.documentLinks(courseId, documentId, opts),
    [courseId, documentId],
  );

  // Seed the editor once the document arrives; never on every render, or a
  // keystroke would be overwritten by the last fetched value.
  useEffect(() => {
    if (document.data && draft === null) setDraft(document.data.body);
  }, [document.data, draft]);

  if (document.loading) return <ViewLoading label="Loading document…" />;
  if (document.error || !document.data) {
    return (
      <ViewError
        message="Failed to load this document."
        onRetry={document.canRetry ? document.reload : undefined}
      />
    );
  }

  const record = document.data;
  const dirty = draft !== null && draft !== record.body;

  async function save() {
    if (draft === null) return;
    setSaving(true);
    try {
      await apiClient.knowledge.updateDocument(courseId, documentId, { body: draft }, { signal: null });
      document.reload();
      links.reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} /> Knowledge base
      </button>

      <PageHeader
        eyebrow={<span>{record.path}</span>}
        title={record.title ?? record.path}
        subtitle={record.description ?? undefined}
        actions={
          <>
            <button type="button" onClick={() => setPreview((p) => !p)}>
              {preview ? "Edit" : "Preview"}
            </button>
            {record.bodyOriginal !== null && (
              <button type="button" onClick={() => setDraft(record.bodyOriginal)}>
                Revert to extraction
              </button>
            )}
            <button
              type="button"
              className="admin-button admin-button--primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      />

      <dl className="admin-knowledge-doc__meta">
        <div>
          <dt>Type</dt>
          <dd>{record.type}</dd>
        </div>
        <div>
          <dt>Indexing</dt>
          <dd>
            <StatusBadge kind={statusKind(record.indexStatus)}>
              {statusLabel(record.indexStatus)}
            </StatusBadge>
          </dd>
        </div>
      </dl>

      {dirty && (
        <p className="admin-inline-note">
          Saving re-queues this document to be re-indexed before the tutor uses the change.
        </p>
      )}

      {preview ? (
        <div className="admin-knowledge-doc__preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft ?? ""}</ReactMarkdown>
        </div>
      ) : (
        <textarea
          aria-label="Document body"
          className="admin-knowledge-doc__editor"
          value={draft ?? ""}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}

      <section className="admin-knowledge-doc__links">
        <h2>Links</h2>
        <ul>
          {links.data?.outbound.map((link) => (
            <li key={link.rawHref}>
              {link.isBroken ? <LinkBreak size={14} /> : <LinkSimple size={14} />}
              <code>{link.rawHref}</code>
              {link.isBroken && <span className="admin-knowledge-doc__broken">broken</span>}
            </li>
          ))}
          {links.data?.outbound.length === 0 && <li>No outbound links.</li>}
        </ul>

        <h2>Referenced by</h2>
        <ul>
          {links.data?.backlinks.map((backlink) => (
            <li key={backlink.sourceDocumentId}>{backlink.sourcePath}</li>
          ))}
          {links.data?.backlinks.length === 0 && <li>Nothing links here yet.</li>}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd apps/admin && npm test -- src/client/views/KnowledgeDocumentView.test.tsx && npm run typecheck`
Expected: PASS, 7 tests.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(admin): OKF document editor with link and backlink panel (#42)


---

### Task 21: `CollectionsView` and `CollectionEditView`

**Files:**
- Create: `apps/admin/src/client/views/CollectionsView.tsx`
- Create: `apps/admin/src/client/views/CollectionEditView.tsx`
- Create: `apps/admin/src/client/views/CollectionsView.test.tsx`
- Create: `apps/admin/src/client/views/CollectionEditView.test.tsx`

**Interfaces:**
- Consumes: `apiClient.knowledge.listCollections/createCollection/deleteCollection/setCollectionItems/listDocuments/listAttachments/attach/detach`, `directoriesOf`/`documentsIn` (Task 19).
- Produces: `CollectionsView({ courseId, onEditCollection })`, `CollectionEditView({ courseId, collectionId, onBack })`.

- [ ] **Step 1: Write the failing tests**

`CollectionsView.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { CollectionsView } from "./CollectionsView";

afterEach(cleanup);

const COLLECTIONS = [
  { id: "col1", name: "Week 1 readings", description: "Intro", documentCount: 2, directoryCount: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
];
const ATTACHMENTS = {
  attachments: [{ id: "a1", collectionId: "col1", scope: { kind: "homework", homeworkId: "hw1" } }],
};

function stubFetch(collections = COLLECTIONS) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/attachments")) return new Response(JSON.stringify(ATTACHMENTS), { status: 200 });
    return new Response(JSON.stringify({ collections }), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("CollectionsView", () => {
  it("lists collections with their resolved counts", async () => {
    stubFetch();
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText("Week 1 readings"));
    expect(screen.getByText(/1 folder, 2 documents/i)).toBeTruthy();
  });

  it("shows where a collection is attached", async () => {
    stubFetch();
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText(/homework/i));
  });

  it("shows an empty state", async () => {
    stubFetch([]);
    render(<CollectionsView courseId="c1" onEditCollection={vi.fn()} />);
    await waitFor(() => screen.getByText(/No collections yet/i));
  });

  it("opens a collection for editing", async () => {
    stubFetch();
    const onEditCollection = vi.fn();
    render(<CollectionsView courseId="c1" onEditCollection={onEditCollection} />);
    await waitFor(() => screen.getByText("Week 1 readings"));
    fireEvent.click(screen.getByText("Week 1 readings"));
    expect(onEditCollection).toHaveBeenCalledWith("col1");
  });
});
```

`CollectionEditView.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { CollectionEditView } from "./CollectionEditView";

afterEach(cleanup);

const DOCUMENTS = {
  documents: [
    { id: "d1", path: "week1/lecture", kind: "concept", type: "transcript", title: "Lecture 1", description: null, tags: null, indexStatus: "pending", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z" },
    { id: "d2", path: "syllabus", kind: "concept", type: "syllabus", title: "Syllabus", description: null, tags: null, indexStatus: "indexed", sourceMaterialId: null, updatedAt: "2026-09-01T00:00:00.000Z" },
  ],
};

function stubFetch(onPut?: (body: unknown) => void) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      onPut?.(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (String(input).includes("/documents")) {
      return new Response(JSON.stringify(DOCUMENTS), { status: 200 });
    }
    return new Response(
      JSON.stringify({ collections: [{ id: "col1", name: "Week 1", description: null, documentCount: 0, directoryCount: 0, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }] }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("CollectionEditView", () => {
  it("offers every folder and document as a selectable item", async () => {
    stubFetch();
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/Syllabus/));
    expect(screen.getByLabelText(/week1/)).toBeTruthy();
  });

  it("sends a folder selection as a directoryPath item", async () => {
    const saved = vi.fn();
    stubFetch(saved);
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/week1/));

    fireEvent.click(screen.getByLabelText(/week1/));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ items: [{ directoryPath: "week1" }] }),
    );
  });

  it("sends a file selection as a documentId item", async () => {
    const saved = vi.fn();
    stubFetch(saved);
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/Syllabus/));

    fireEvent.click(screen.getByLabelText(/Syllabus/));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith({ items: [{ documentId: "d2" }] }));
  });

  it("counts documents not yet indexed so the instructor knows what is live", async () => {
    stubFetch();
    render(<CollectionEditView courseId="c1" collectionId="col1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText(/week1/));

    fireEvent.click(screen.getByLabelText(/week1/));
    await waitFor(() => screen.getByText(/1 document.*1 not yet indexed/i));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/admin && npm test -- src/client/views/Collection`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `CollectionsView`**

```tsx
/* --------------------------------------------------------------------------
   CollectionsView — named selections over the bundle (#42).

   The "attached to" column is the payload of this view. Resolution is
   most-specific-wins, so an instructor's real question is not "what is in
   this collection" but "where does it apply, and does something narrower
   override it". Showing every attachment on the row is the cheapest honest
   answer to that.
   -------------------------------------------------------------------------- */

import { PageHeader } from "../components/PageHeader";
import { RecordId } from "../components/RecordId";
import { ViewEmpty, ViewError, ViewLoading } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import type { AttachmentListPayload, AttachmentScopePayload, CollectionListPayload } from "@llteacher/ui/api";

export type CollectionsViewProps = {
  courseId: string;
  onEditCollection: (collectionId: string) => void;
};

function describeScope(scope: AttachmentScopePayload): string {
  switch (scope.kind) {
    case "course":
      return "Course default";
    case "homework":
      return "Homework";
    case "section":
      return "Section";
    case "llmConfig":
      return "Tutor config";
  }
}

export function CollectionsView({ courseId, onEditCollection }: CollectionsViewProps) {
  const collections = useApiResource<CollectionListPayload>(
    (opts) => apiClient.knowledge.listCollections(courseId, opts),
    [courseId],
  );
  const attachments = useApiResource<AttachmentListPayload>(
    (opts) => apiClient.knowledge.listAttachments(courseId, opts),
    [courseId],
  );

  const rows = collections.data?.collections ?? [];

  return (
    <div className="admin-view">
      <PageHeader
        eyebrow={`COLLECTIONS · ${rows.length} RECORDS`}
        title="Collections"
        subtitle="A collection is what an assignment grounds on. The narrowest attachment wins: section, then homework, then course, then tutor config."
      />

      {collections.loading && <ViewLoading label="Loading collections…" />}
      {collections.error && (
        <ViewError
          message="Failed to load collections."
          onRetry={collections.canRetry ? collections.reload : undefined}
        />
      )}

      {collections.data &&
        (rows.length === 0 ? (
          <ViewEmpty message="No collections yet. Create one to ground an assignment on specific materials." />
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Contents</th>
                <th>Attached to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((collection, i) => {
                const mine =
                  attachments.data?.attachments.filter((a) => a.collectionId === collection.id) ??
                  [];
                return (
                  <tr key={collection.id} onClick={() => onEditCollection(collection.id)}>
                    <td>
                      <RecordId prefix="COL" index={i + 1} size="sm" />
                    </td>
                    <td>{collection.name}</td>
                    <td>
                      {collection.directoryCount} folder
                      {collection.directoryCount === 1 ? "" : "s"}, {collection.documentCount}{" "}
                      document{collection.documentCount === 1 ? "" : "s"}
                    </td>
                    <td>
                      {mine.length === 0
                        ? "Not attached"
                        : mine.map((a) => describeScope(a.scope)).join(", ")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement `CollectionEditView`**

```tsx
/* --------------------------------------------------------------------------
   CollectionEditView — choosing what a collection contains (#42).

   A checked FOLDER is a live subtree, not a snapshot: files added to it
   later join the collection. That is what "select the folders that make up a
   collection" means, and the copy says so, because the alternative reading
   (a one-time expansion) produces a very different mental model.

   The resolved pane shows how many documents are not yet indexed. Without
   it, an instructor attaches a collection of freshly uploaded PDFs, sees a
   healthy document count, and cannot tell that the tutor can currently
   retrieve none of them.
   -------------------------------------------------------------------------- */

import { useMemo, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { PageHeader } from "../components/PageHeader";
import { ViewError, ViewLoading } from "../components/ViewState";
import { apiClient } from "../lib/api-client";
import { useApiResource } from "../lib/useApiResource";
import { depthOf, directoriesOf, documentsIn, nameOf } from "../lib/documentTree";
import type { CollectionItemBody, KnowledgeDocumentListPayload } from "@llteacher/ui/api";

export type CollectionEditViewProps = {
  courseId: string;
  collectionId: string;
  onBack: () => void;
};

export function CollectionEditView({ courseId, collectionId, onBack }: CollectionEditViewProps) {
  const [directories, setDirectories] = useState<Set<string>>(new Set());
  const [documentIds, setDocumentIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const documents = useApiResource<KnowledgeDocumentListPayload>(
    (opts) => apiClient.knowledge.listDocuments(courseId, opts),
    [courseId],
  );

  const all = documents.data?.documents ?? [];
  const folders = useMemo(() => directoriesOf(all).filter((d) => d !== ""), [all]);

  /** Mirrors the server's live-subtree rule so the count on screen is the
   *  count the tutor will retrieve. The trailing slash matters: without it
   *  "week" would also match "weekend/b". */
  const selected = useMemo(() => {
    return all.filter(
      (d) =>
        d.kind === "concept" &&
        (documentIds.has(d.id) || [...directories].some((dir) => d.path.startsWith(`${dir}/`))),
    );
  }, [all, directories, documentIds]);

  const notIndexed = selected.filter((d) => d.indexStatus !== "indexed").length;

  function toggle<T>(set: Set<T>, value: T, apply: (next: Set<T>) => void) {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    apply(next);
  }

  async function save() {
    setSaving(true);
    try {
      const items: CollectionItemBody[] = [
        ...[...directories].map((directoryPath) => ({ directoryPath })),
        ...[...documentIds].map((documentId) => ({ documentId })),
      ];
      await apiClient.knowledge.setCollectionItems(courseId, collectionId, items, { signal: null });
      onBack();
    } finally {
      setSaving(false);
    }
  }

  if (documents.loading) return <ViewLoading label="Loading knowledge base…" />;
  if (documents.error) {
    return (
      <ViewError
        message="Failed to load the knowledge base."
        onRetry={documents.canRetry ? documents.reload : undefined}
      />
    );
  }

  return (
    <div className="admin-view">
      <button type="button" className="admin-back" onClick={onBack}>
        <ArrowLeft size={14} /> Collections
      </button>

      <PageHeader
        eyebrow="COLLECTION"
        title="Choose contents"
        subtitle="A checked folder stays live — documents added to it later join this collection automatically."
        actions={
          <button
            type="button"
            className="admin-button admin-button--primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        }
      />

      <div className="admin-collection-edit">
        <fieldset className="admin-collection-edit__picker">
          <legend>Folders</legend>
          {folders.map((dir) => (
            <label key={dir} style={{ paddingLeft: `${depthOf(dir) * 14}px` }}>
              <input
                type="checkbox"
                checked={directories.has(dir)}
                onChange={() => toggle(directories, dir, setDirectories)}
              />
              {nameOf(dir)}
            </label>
          ))}

          <legend>Documents</legend>
          {all
            .filter((d) => d.kind === "concept")
            .map((document) => (
              <label key={document.id}>
                <input
                  type="checkbox"
                  checked={documentIds.has(document.id)}
                  onChange={() => toggle(documentIds, document.id, setDocumentIds)}
                />
                {document.title ?? document.path}
              </label>
            ))}
        </fieldset>

        <aside className="admin-collection-edit__resolved">
          <h2>Resolved contents</h2>
          <p>
            {selected.length} document{selected.length === 1 ? "" : "s"}
            {notIndexed > 0 && ` · ${notIndexed} not yet indexed`}
          </p>
          <ul>
            {selected.map((document) => (
              <li key={document.id}>{document.path}</li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}
```

Import only `depthOf`, `directoriesOf`, and `nameOf` from `documentTree` — `documentsIn` is not used in this view, and `noUnusedLocals` is on in this project's tsconfig, so the extra import fails the build.

- [ ] **Step 5: Run to verify they pass, then commit**

Run: `cd apps/admin && npm test -- src/client/views/Collection && npm run typecheck`
Expected: PASS, 8 tests.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(admin): collection list and contents picker (#42)


---

### Task 22: Attach knowledge from the homework form

**Files:**
- Modify: `apps/admin/src/client/components/HomeworkForm.tsx`
- Modify: `apps/admin/src/client/components/HomeworkForm.test.tsx`

**Interfaces:**
- Consumes: `apiClient.knowledge.listCollections/listAttachments/attach/detach/resolve`.
- Produces: two new `HomeworkFormProps` members, `courseId: string` and `homeworkId?: string`. No other exported symbols.

This is the discoverable path — an instructor setting up an assignment will look here, not in a separate collections screen. It is also where the override rule needs to be visible: attaching at homework level while a section overrides it is exactly the confusion most-specific-wins produces.

**Read `HomeworkForm.tsx` before you start.** Its current props are exactly
`{ initialData?, onSubmit, llmConfigs, isLoading? }` (line 73) — it has **no
`courseId` and no `homeworkId`**, so both must be added to `HomeworkFormProps`
and threaded from the two call sites, `HomeworkCreateView.tsx` and
`HomeworkEditView.tsx`.

**The fieldset renders only when `homeworkId` is set.** In create mode there is
no homework yet, so there is nothing for an attachment to point at — a
collection cannot be attached to a homework that does not exist. Render the
fieldset with a short line explaining that knowledge can be attached once the
assignment is saved, rather than showing dead checkboxes. `HomeworkCreateView`
therefore passes `courseId` only.

- [ ] **Step 1: Write the failing test**

Append to `HomeworkForm.test.tsx`:

```tsx
it("explains that knowledge waits for a save when creating a new homework", async () => {
  stubFetchWithCollections();
  renderForm();  // no homeworkId — create mode
  await waitFor(() => screen.getByText(/Save the assignment first/i));
  expect(screen.queryByLabelText(/Week 1 readings/)).toBeNull();
});

it("lists the course's collections as attachable knowledge", async () => {
  stubFetchWithCollections();
  renderForm({ homeworkId: "hw1" });
  await waitFor(() => screen.getByLabelText(/Week 1 readings/));
});

it("marks the collection currently attached to this homework", async () => {
  stubFetchWithCollections();
  renderForm({ homeworkId: "hw1" });
  const checkbox = (await screen.findByLabelText(/Week 1 readings/)) as HTMLInputElement;
  await waitFor(() => expect(checkbox.checked).toBe(true));
});

it("warns when a section overrides the homework's knowledge", async () => {
  stubFetchWithCollections({ resolve: { level: "section", collectionIds: ["col2"], documents: [] } });
  renderForm({ homeworkId: "hw1" });
  await waitFor(() => screen.getByText(/a section overrides/i));
});

it("says what the tutor will retrieve when nothing is attached", async () => {
  stubFetchWithCollections({ resolve: { level: "none", collectionIds: [], documents: [] } });
  renderForm({ homeworkId: "hw1" });
  await waitFor(() => screen.getByText(/no course materials/i));
});
```

Add a `stubFetchWithCollections` helper alongside the file's existing fetch stub, returning `{ collections: [{ id: "col1", name: "Week 1 readings", … }] }` for `/knowledge/collections`, `{ attachments: [{ id: "a1", collectionId: "col1", scope: { kind: "homework", homeworkId: "hw1" } }] }` for `/knowledge/attachments`, and the supplied `resolve` payload (defaulting to `{ level: "homework", collectionIds: ["col1"], documents: [] }`) for `/knowledge/resolve`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/admin && npm test -- src/client/components/HomeworkForm.test.tsx`
Expected: FAIL — no such label.

- [ ] **Step 3: Implement**

Add to `HomeworkForm.tsx`, after the LLM-config field:

```tsx
  /* #42: knowledge attachment lives here, not only on the collections
     screen, because this is where an instructor setting up an assignment
     will look for it.

     The resolution note below is not decoration. Attachment resolves
     most-specific-wins, so a section attachment silently replaces whatever
     is set here -- which is the one genuinely surprising consequence of
     override semantics, and the reason /knowledge/resolve returns the
     deciding `level` alongside the collections. */
  const collections = useApiResource<CollectionListPayload>(
    (opts) => apiClient.knowledge.listCollections(courseId, opts),
    [courseId],
  );
  const attachments = useApiResource<AttachmentListPayload>(
    (opts) => apiClient.knowledge.listAttachments(courseId, opts),
    [courseId],
  );
  const resolution = useApiResource<ResolutionPayload>(
    (opts) =>
      homeworkId
        ? apiClient.knowledge.resolve(courseId, { homeworkId }, opts)
        : Promise.resolve({ level: "none", collectionIds: [], documents: [] }),
    [courseId, homeworkId],
  );

  const attachedHere = new Map(
    (attachments.data?.attachments ?? [])
      .filter((a) => a.scope.kind === "homework" && a.scope.homeworkId === homeworkId)
      .map((a) => [a.collectionId, a.id]),
  );

  async function toggleCollection(collectionId: string) {
    if (!homeworkId) return;
    const existing = attachedHere.get(collectionId);
    if (existing) {
      await apiClient.knowledge.detach(courseId, existing, { signal: null });
    } else {
      await apiClient.knowledge.attach(
        courseId,
        collectionId,
        { kind: "homework", homeworkId },
        { signal: null },
      );
    }
    attachments.reload();
    resolution.reload();
  }
```

and in the returned JSX:

```tsx
      <fieldset className="admin-form__fieldset">
        <legend>Knowledge</legend>
        <p className="admin-form__hint">
          Collections the tutor grounds on for this assignment.
        </p>

        {/* Create mode: nothing exists yet for an attachment to point at, so
            say that rather than rendering checkboxes that cannot be saved. */}
        {!homeworkId && (
          <p className="admin-form__hint">
            Save the assignment first — knowledge can be attached once it exists.
          </p>
        )}

        {homeworkId && (collections.data?.collections ?? []).map((collection) => (
          <label key={collection.id}>
            <input
              type="checkbox"
              checked={attachedHere.has(collection.id)}
              onChange={() => void toggleCollection(collection.id)}
            />
            {collection.name}
          </label>
        ))}

        {homeworkId && resolution.data?.level === "section" && (
          <p className="admin-inline-note">
            At least one section overrides this — those sections ground on their own
            collection instead of this one.
          </p>
        )}
        {homeworkId && resolution.data?.level === "none" && (
          <p className="admin-inline-note">
            Nothing attached, so the tutor answers with no course materials.
          </p>
        )}
      </fieldset>
```

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd apps/admin && npm test -- src/client/components/HomeworkForm.test.tsx && npm run typecheck`
Expected: PASS, including every pre-existing test in that file.

Invoke the `/commit` skill to stage and commit. Suggested message:

> feat(admin): attach knowledge collections from the homework form (#42)


---

### Task 23: Wire the views into `App.tsx` and gate Phase 3

**Files:**
- Modify: `apps/admin/src/client/App.tsx` (the `View` union ~line 60, the sidebar `onNavigate` map, and the render switch)
- Modify: `apps/admin/src/client/App.test.tsx`

**Interfaces:**
- Consumes: every view from Tasks 19–21.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Append to `App.test.tsx`:

```tsx
it("navigates to the knowledge base from the sidebar", async () => {
  renderApp({ role: "instructor" });
  fireEvent.click(await screen.findByRole("button", { name: /Knowledge/ }));
  await waitFor(() => screen.getByText(/Knowledge base/));
});

it("does not offer knowledge to a TA, whose requests would 403", async () => {
  renderApp({ role: "ta" });
  await waitFor(() => screen.getByRole("navigation"));
  expect(screen.queryByRole("button", { name: /Knowledge/ })).toBeNull();
});
```

Use whatever `renderApp` helper the file already defines; if it takes a different shape, follow it rather than adding a new one.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/admin && npm test -- src/client/App.test.tsx`
Expected: FAIL — no Knowledge button.

- [ ] **Step 3: Implement**

Extend the `View` union:

```ts
  | { kind: "knowledge" }
  | { kind: "knowledge-document"; documentId: string }
  | { kind: "collections" }
  | { kind: "collection-edit"; collectionId: string }
```

Add to the render switch:

```tsx
      {view.kind === "knowledge" && (
        <KnowledgeView
          courseId={courseId}
          onOpenDocument={(documentId) => setView({ kind: "knowledge-document", documentId })}
        />
      )}
      {view.kind === "knowledge-document" && (
        <KnowledgeDocumentView
          courseId={courseId}
          documentId={view.documentId}
          onBack={() => setView({ kind: "knowledge" })}
        />
      )}
      {view.kind === "collections" && (
        <CollectionsView
          courseId={courseId}
          onEditCollection={(collectionId) => setView({ kind: "collection-edit", collectionId })}
        />
      )}
      {view.kind === "collection-edit" && (
        <CollectionEditView
          courseId={courseId}
          collectionId={view.collectionId}
          onBack={() => setView({ kind: "collections" })}
        />
      )}
```

Map the sidebar key in the existing `onNavigate` handler: `knowledge` → `{ kind: "knowledge" }`. Set the `TopNav` breadcrumb to `"Instructor Console · Knowledge"` for these views, matching the pattern the other views use.

- [ ] **Step 4: Add status polling**

In `KnowledgeView`, poll only while work is outstanding:

```tsx
  /* Poll only while something is actually in flight, and stop when nothing
     is: a blanket timer would keep an idle console requesting forever, and
     the request is a full listing. */
  const pending = (materials.data?.materials ?? []).some(
    (m) => m.status === "pending" || m.status === "processing",
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      materials.reload();
      documents.reload();
    }, 4000);
    return () => clearInterval(timer);
  }, [pending, materials, documents]);
```

Add a test to `KnowledgeView.test.tsx`:

```tsx
it("stops polling once nothing is pending", async () => {
  vi.useFakeTimers();
  const fetchMock = stubFetch({
    materials: { materials: [{ ...MATERIALS[0], status: "ready" }] },
  });
  render(<KnowledgeView courseId="c1" onOpenDocument={vi.fn()} />);
  await vi.advanceTimersByTimeAsync(12_000);
  // Two initial loads (documents + materials) and nothing more.
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
```

- [ ] **Step 5: Full gate**

Run from the repo root: `npm run typecheck && npm run test && npm run build`
Expected: PASS everywhere.

- [ ] **Step 6: Manual verification**

```bash
cd apps/web && npm run dev      # API on 5173
cd apps/admin && npm run dev    # console on 2312
```

Walk the acceptance path as an instructor:
1. Knowledge → Upload a `.vtt` transcript → it appears as a `transcript` document with `indexStatus: pending`.
2. Upload a `.pdf` → the material shows `pending` with the "#40 not implemented" note, and no document is created.
3. Open the transcript document → edit the body → save → the note about re-indexing appears, links rebuild.
4. Create a folder, move nothing into it, reload → the folder survives (its `index` document exists).
5. Collections → create one → check a folder → the resolved pane shows the live subtree and the not-yet-indexed count.
6. Homeworks → edit a homework → Knowledge fieldset → attach the collection → the resolution note reflects it.

- [ ] **Step 7: Commit and open the PR**

Invoke the `/commit` skill. Suggested message:

> feat(admin): wire knowledge views into the console shell (#42)

Then invoke the `/create-pr` skill. Suggested title and body:

> **M-KM PR3: knowledge management console (#42)**
>
> Phase 3 of docs/superpowers/specs/2026-09-09-knowledge-management-design.md. Bundle browser, OKF document editor with link/backlink panel, collection list and picker, and homework-form attachment.
>
> Closes #42, and resolves epic #44 open design question 4 in favour of per-homework/section grounding rather than a per-course toggle.

---

## Follow-ups this plan does not cover

Recorded so a reviewer does not read their absence as an oversight:

- Chunking and embedding of documents (#40). `material_chunks` is repointed and empty; nothing writes it.
- Retrieval, prompt grounding, and citations (#41). Will call `resolveForTarget` and must respect the override chain.
- Whether retrieval should traverse `knowledge_links` (OKF progressive disclosure) as well as vector top-k. The graph is built here; using it is #41's decision.
- Document rename/move with inbound-link rewriting. The spec lists a `/move` endpoint; it is deferred because a rename that silently rewrites other documents' bodies needs its own design pass, and delete-plus-recreate covers the case meanwhile.
- Presigned uploads above 25 MB.
- Version history beyond `body_original` and `log.md`.
- Cross-course material reuse and term rollover (#92).
