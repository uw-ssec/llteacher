import { and, eq } from "drizzle-orm";
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
