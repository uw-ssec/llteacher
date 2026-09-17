import { OcrError, type OcrOptions } from "./ocr";
import type { Db } from "../../../db/client";
import { getMaterialForReingest, setMaterialDocumentPath, setMaterialStatus } from "../../repositories/materials";
import type { CourseScope } from "../../repositories/scope";
import { conceptIdFromUpload } from "../conceptId";
import { ConceptExistsError, type KnowledgeService } from "../service";
import { logServerError } from "../../utils/errors";
import { extract } from "./index";
import { withMaterialLock } from "../materialLock";

export interface ExtractionJob {
  ocr?: OcrOptions;
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

// OKF rejects frontmatter delimiters even inside quoted metadata. Keep the
// source body intact; normalize only the short metadata used for discovery.
function metadataText(value: string, limit: number): string {
  return value.replace(/-{3,}/g, "—").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** pending -> processing -> ready | failed, or back to pending with a reason
 *  for a format the pipeline cannot read yet. Database errors may propagate. */
export async function extractMaterial(job: ExtractionJob): Promise<{ status: "ready" | "pending" | "failed"; documentPath: string | null }> {
  return withMaterialLock(job.courseId, job.materialId, async () => {
    const current = await getMaterialForReingest(job.db, job.courseId, job.materialId);
    // A deleted queued upload must never publish a new concept.
    if (!current) return { status: "failed" as const, documentPath: null };
    return extractCurrentMaterial({ ...job, existingDocumentPath: current.documentPath });
  });
}

async function extractCurrentMaterial(job: ExtractionJob): Promise<{ status: "ready" | "pending" | "failed"; documentPath: string | null }> {
  const { db, courseId, materialId } = job;
  try {
    await setMaterialStatus(db, courseId, materialId, "processing", null);
    const outcome = await extract(job.filename, job.bytes, job.ocr);
    if (outcome.kind === "unsupported") {
      await setMaterialStatus(db, courseId, materialId, "pending", `${outcome.reason} The upload is stored; author a document manually to ground on it.`);
      return { status: "pending", documentPath: job.existingDocumentPath };
    }
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
          id, type: metadataText(outcome.type, 80), title: metadataText(outcome.title, 300),
          description: metadataText(outcome.description || outcome.markdown || outcome.title, 200),
          body: outcome.markdown, resource: `llteacher://materials/${materialId}`,
        });
        documentPath = id;
      } catch (err) {
        if (!(err instanceof ConceptExistsError)) throw err;
        // A process can stop after creating the file but before storing its
        // path in Postgres. Adopt only this material's own concept on Retry.
        const existing = await job.knowledge.show(courseId, id, { includeInbound: false });
        if (existing?.resource === `llteacher://materials/${materialId}`) {
          const updated = await job.knowledge.update(courseId, id, { body: outcome.markdown });
          if (updated) documentPath = id;
        }
      }
    }
    if (!documentPath) throw new Error("no free concept id after 25 attempts");
    await setMaterialDocumentPath(db, courseId, materialId, documentPath);
    await setMaterialStatus(db, courseId, materialId, "ready", null);
    return { status: "ready", documentPath };
  } catch (err) {
    logServerError("extract.write", err, { materialId });
    await setMaterialStatus(db, courseId, materialId, "failed", err instanceof OcrError ? err.message : "The extracted text could not be saved to the knowledge base. The uploaded file is still stored; try reingesting.");
    return { status: "failed", documentPath: job.existingDocumentPath };
  }
}

/* --------------------------------------------------------------------------
   The extraction queue (I-1, final review).

   A folder upload posts one request per file, and each handler used to fire
   its own bare `setImmediate(extractMaterial)`. 500 files therefore meant
   500 extractions running at once, each holding its whole upload in memory
   as an ArrayBuffer and each contending for the same per-course write lock.
   A FIFO queue with a fixed concurrency of 2 bounds both: at most two
   decompressions run at a time, and the backlog is a list of jobs rather
   than a wavefront of half-finished ones.

   In-process only, deliberately: the deployment is a single ECS task (see
   the service's own write-lock comment), and the queue's whole job is to
   pace work this process has already accepted. A restart drops the backlog,
   which is why a queued material stays at `pending` in the database with a
   Retry button next to it rather than being marked ready optimistically.
   -------------------------------------------------------------------------- */

const MAX_CONCURRENT_EXTRACTIONS = 2;

const queue: ExtractionJob[] = [];
const scheduled = new Set<string>();
const jobKey = (job: ExtractionJob) => `${job.courseId}:${job.materialId}`.toLowerCase();
const inFlight = new Set<Promise<void>>();
let drainWaiters: Array<() => void> = [];

/** How many jobs are waiting for a slot (not counting those already running). */
export function pendingExtractions(): number {
  return queue.length;
}

function settleDrainWaiters(): void {
  if (queue.length > 0 || inFlight.size > 0) return;
  const waiters = drainWaiters;
  drainWaiters = [];
  for (const waiter of waiters) waiter();
}

/** Starts jobs until the concurrency limit is reached or the queue is empty.
 *  Called on every enqueue and again as each job settles. */
function pump(): void {
  while (inFlight.size < MAX_CONCURRENT_EXTRACTIONS && queue.length > 0) {
    const job = queue.shift()!;
    const running: Promise<void> = extractMaterial(job)
      .then(() => undefined)
      .catch((err) => logServerError("extract.job", err, { materialId: job.materialId }))
      .finally(() => {
        scheduled.delete(jobKey(job));
        inFlight.delete(running);
        pump();
        settleDrainWaiters();
      });
    inFlight.add(running);
  }
}

export function scheduleExtraction(job: ExtractionJob): void {
  if (scheduled.has(jobKey(job))) return;
  scheduled.add(jobKey(job));
  queue.push(job);
  // Still deferred to the next tick, for the same reason the pre-queue
  // version was: the request handler that enqueued this answers 201 first.
  setImmediate(pump);
}

/** Resolves once nothing is queued or running, or once `timeoutMs` passes --
 *  whichever comes first. The timeout is what keeps a shutdown bounded: a
 *  stuck extraction must not hold SIGTERM open past the orchestrator's own
 *  kill deadline. */
export function drainExtractions(timeoutMs: number): Promise<void> {
  if (queue.length === 0 && inFlight.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    drainWaiters.push(finish);
  });
}
