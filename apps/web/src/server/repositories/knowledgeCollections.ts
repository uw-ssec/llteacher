/* --------------------------------------------------------------------------
   Collections: named selections over the bundle, and where they attach (#42).

   The interesting part is listDocumentsInCollections. A directory item
   resolves LIVE rather than being expanded to a document list at save time,
   because "attach the Week 3 folder" should keep meaning that after Week 3
   gains a file. That makes it a prefix query, and the prefix needs the
   trailing slash: without it, directory "week" would swallow "weekend/b".
   -------------------------------------------------------------------------- */

import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  collectionAttachments,
  collectionItems,
  homeworks,
  knowledgeDocuments,
  materialCollections,
  sections,
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

/** The raw item selection backing a collection -- documents and directories,
 *  distinguishably -- so an editor can restore exactly what was checked.
 *  This is deliberately NOT listDocumentsInCollections: a folder selection
 *  is not the same as the documents it currently happens to contain, and
 *  resolving it away here would make it impossible for the console to
 *  re-check the right boxes. Guarded on scope first: null (not an empty
 *  array) tells the route a foreign collection id was named, so it can
 *  answer 404 rather than "an empty collection". */
export async function getCollectionItems(
  db: Db,
  scope: CourseScope,
  collectionId: string,
): Promise<CollectionItemInput[] | null> {
  const owned = await getCollection(db, scope, collectionId);
  if (!owned) return null;

  const rows = await db
    .select({
      documentId: collectionItems.documentId,
      directoryPath: collectionItems.directoryPath,
    })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, collectionId))
    .orderBy(collectionItems.createdAt);

  return rows.map((r) =>
    r.documentId ? { documentId: r.documentId } : { directoryPath: r.directoryPath! },
  );
}

/** Escapes the three characters that are meaningful to Postgres's LIKE
 *  operator (`\`, `%`, `_`) so a caller-controlled directory path is matched
 *  literally rather than as a pattern. Postgres's default LIKE escape
 *  character is backslash with no `ESCAPE` clause required, so escaping the
 *  backslash itself first (before introducing any new ones) is what keeps
 *  this correct. */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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
  // "weekend/b". The directory itself also has to be escaped before it goes
  // into the pattern (I-6): `_` is inside PATH_RE's accepted alphabet, and
  // in a LIKE pattern it means "any one character" -- unescaped, a
  // directory named "week_1" would also match "weekX1/...". Postgres's
  // default LIKE escape character is a literal backslash with no ESCAPE
  // clause needed, so escaping backslash, `%`, and `_` here is sufficient.
  for (const dir of directories) {
    predicates.push(like(knowledgeDocuments.path, `${escapeLikePattern(dir)}/%`));
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

/** Tenancy check for a homework-scoped attachment. `homeworks` carries its
 *  own `course_id`, so this is a direct lookup: does the referenced
 *  homework belong to the acting course? The foreign key on
 *  collection_attachments.scope_homework_id only proves the homework
 *  exists SOMEWHERE -- never that it belongs here. */
export async function homeworkBelongsToCourse(
  db: Db,
  scope: CourseScope,
  homeworkId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: homeworks.id })
    .from(homeworks)
    .where(and(eq(homeworks.id, homeworkId), eq(homeworks.courseId, scope)))
    .limit(1);
  return !!row;
}

/** Tenancy check for a section-scoped attachment. `sections` has no
 *  `course_id` of its own -- only `homework_id` -- so the course is reached
 *  through the one join to `homeworks`, which does carry it. */
export async function sectionBelongsToCourse(
  db: Db,
  scope: CourseScope,
  sectionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: sections.id })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(and(eq(sections.id, sectionId), eq(homeworks.courseId, scope)))
    .limit(1);
  return !!row;
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
