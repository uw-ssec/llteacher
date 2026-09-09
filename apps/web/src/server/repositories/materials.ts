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
