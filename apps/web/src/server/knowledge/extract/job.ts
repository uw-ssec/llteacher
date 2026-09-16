import type { Db } from "../../../db/client";
import { setMaterialDocumentPath, setMaterialStatus } from "../../repositories/materials";
import type { CourseScope } from "../../repositories/scope";
import { conceptIdFromUpload } from "../conceptId";
import { ConceptExistsError, type KnowledgeService } from "../service";
import { logServerError } from "../../utils/errors";
import { extract } from "./index";

export interface ExtractionJob {
  db: Db;
  courseId: CourseScope;
  materialId: string;
  filename: string;
  relativePath: string | null;
  bytes: ArrayBuffer;
  knowledge: KnowledgeService;
  existingDocumentPath: string | null;
}

const MAX_ID_ATTEMPTS = 25;

/** pending -> processing -> ready | failed, or back to pending with a reason
 *  for a format the pipeline cannot read yet. Never throws. */
export async function extractMaterial(job: ExtractionJob): Promise<{ status: "ready" | "pending" | "failed"; documentPath: string | null }> {
  const { db, courseId, materialId } = job;
  await setMaterialStatus(db, courseId, materialId, "processing", null);
  const outcome = await extract(job.filename, job.bytes);
  if (outcome.kind === "unsupported") {
    await setMaterialStatus(db, courseId, materialId, "pending", `${outcome.reason} The upload is stored; author a document manually to ground on it.`);
    return { status: "pending", documentPath: job.existingDocumentPath };
  }
  try {
    if (job.existingDocumentPath) {
      const updated = await job.knowledge.update(courseId, job.existingDocumentPath, { body: outcome.markdown });
      if (updated) {
        await setMaterialStatus(db, courseId, materialId, "ready", null);
        return { status: "ready", documentPath: job.existingDocumentPath };
      }
    }
    const base = conceptIdFromUpload(job.relativePath, job.filename);
    let documentPath: string | null = null;
    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS && !documentPath; attempt++) {
      const id = attempt === 1 ? base : `${base}-${attempt}`;
      try {
        await job.knowledge.create(courseId, {
          id, type: outcome.type, title: outcome.title,
          description: outcome.markdown.replace(/\s+/g, " ").slice(0, 200).trim() || outcome.title,
          body: outcome.markdown, resource: `llteacher://materials/${materialId}`,
        });
        documentPath = id;
      } catch (err) {
        if (!(err instanceof ConceptExistsError)) throw err;
      }
    }
    if (!documentPath) throw new Error("no free concept id after 25 attempts");
    await setMaterialDocumentPath(db, courseId, materialId, documentPath);
    await setMaterialStatus(db, courseId, materialId, "ready", null);
    return { status: "ready", documentPath };
  } catch (err) {
    logServerError("extract.write", err, { materialId });
    await setMaterialStatus(db, courseId, materialId, "failed", "The extracted text could not be saved to the knowledge base. The uploaded file is still stored; try reingesting.");
    return { status: "failed", documentPath: job.existingDocumentPath };
  }
}

export function scheduleExtraction(job: ExtractionJob): void {
  setImmediate(() => {
    extractMaterial(job).catch((err) => logServerError("extract.job", err, { materialId: job.materialId }));
  });
}
