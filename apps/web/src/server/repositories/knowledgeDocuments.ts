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
