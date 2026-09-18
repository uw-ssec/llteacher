import { ocrOptionsFromEnv } from "../knowledge/extract/ocr";
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

   These are instructor-authoring routes (plan invariant: every course route
   nests under requireInstructorOf()). Task 17 wraps registration in that
   guard too, but instructorScope() (utils/guards.ts) checks isInstructorOf
   directly rather than relying solely on that wrapper, so a handler called
   on its own -- as this file's own tests do -- still refuses a student.

   instructorScope() used to be a private copy here (`scopeOf`). Task 15
   extracted the one true implementation into utils/guards.ts, beside
   requireInstructorOf which already owns this concern -- see that file's
   doc comment for why bare `isMemberOf` was the wrong predicate.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import { makeDb } from "../../db/client";
import type { AppEnv } from "../context";
import { instructorScope } from "../utils/guards";
import {
  deleteMaterial,
  getMaterialForReingest,
  insertMaterial,
  listMaterialsForCourse,
  setMaterialStatus,
  setMaterialStorageKey,
} from "../repositories/materials";
import { knowledgeServiceFromEnv } from "../knowledge/service";
import { scheduleExtraction, extractMaterial } from "../knowledge/extract/job";
import { materialStorageKey, storageFromEnv, StorageError } from "../storage/objectStore";
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  extensionOf,
  sourceTypeFor,
} from "../knowledge/convert";
import { withMaterialLock } from "../knowledge/materialLock";
import { logServerError } from "../utils/errors";
import type { MaterialListPayload } from "@llteacher/ui/api";

function membershipIdOf(c: Context<AppEnv>, courseId: string): string | null {
  return c.get("authContext")?.memberships.find((m) => m.courseId === courseId)?.id ?? null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function listMaterialsHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const materials = await listMaterialsForCourse(db, scope);
  return c.json({ materials } satisfies MaterialListPayload);
}

export async function uploadMaterialHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "No file was uploaded." }, 400);
  }

  const relativePathRaw = form.get("relativePath");
  const relativePath =
    typeof relativePathRaw === "string" && relativePathRaw.length > 0 && relativePathRaw.length <= 400 &&
    !relativePathRaw.split("/").some((s) => s === "" || s === "." || s === "..")
      ? relativePathRaw
      : null;
  if (typeof relativePathRaw === "string" && relativePathRaw.length > 0 && relativePath === null) {
    return c.json({ error: "Invalid relativePath." }, 400);
  }

  const extension = extensionOf(file.name);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    return c.json(
      {
        error: `Unsupported file type ".${extension}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`,
      },
      400,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return c.json(
      { error: `File is larger than the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.` },
      413,
    );
  }

  // scope is the verified courseId (courseScopeFromAuthContext only mints
  // one after confirming the membership), so this reads it off scope rather
  // than re-reading the possibly-absent route param.
  const membershipId = membershipIdOf(c, scope);
  if (!membershipId) return c.json({ error: "Not permitted." }, 403);

  const bytes = await file.arrayBuffer();
  const checksum = await sha256Hex(bytes);
  const db = makeDb(c.env.DATABASE_URL);

  // Insert first: the row's id is part of the storage key, so a stored
  // object always has a row that names it. The reverse order can strand an
  // object nothing references.
  //
  // The row starts at `pending` unconditionally now: extraction runs after
  // this handler returns (scheduleExtraction, below), so nothing here yet
  // knows whether the format is supported or the concept write will land.
  const material = await insertMaterial(db, scope, {
    title: file.name.replace(/\.[^.]+$/, ""),
    sourceType: sourceTypeFor(file.name),
    originalFilename: file.name,
    relativePath,
    storageKey: "",
    byteSize: file.size,
    contentType: file.type || null,
    checksum,
    status: "pending",
    errorDetail: null,
    uploadedById: membershipId,
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
  await setMaterialStorageKey(db, scope, material.id, key);

  // Extraction runs off the request path: on Node there is no per-request
  // CPU cap, so this enqueues the write rather than making the instructor
  // wait on it synchronously. The handler answers 201 pending immediately;
  // the console polls status.
  //
  // The queue runs two jobs at a time (extract/job.ts), so the memory held
  // by queued upload bytes is bounded by what this instructor has uploaded
  // and not yet had extracted -- not, as before the queue, by every upload
  // being decompressed at once.
  scheduleExtraction({
    db,
    courseId: scope,
    materialId: material.id,
    filename: file.name,
    relativePath,
    bytes,
    ocr: ocrOptionsFromEnv(c.env),
    knowledge: knowledgeServiceFromEnv(c.env),
    existingDocumentPath: null,
  });

  return c.json({ id: material.id, status: "pending" }, 201);
}

export async function deleteMaterialHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const materialId = c.req.param("materialId");
  if (!materialId) return c.json({ error: "No such material." }, 404);

  const db = makeDb(c.env.DATABASE_URL);
  return withMaterialLock(scope, materialId, async () => {
    const material = await getMaterialForReingest(db, scope, materialId);
    if (!material) return c.json({ error: "No such material." }, 404);
    // Retrieval uses the filesystem, so remove grounding before deleting
    // its retry handle in Postgres. A failed removal must remain retryable.
    if (material.documentPath) {
      try {
        await knowledgeServiceFromEnv(c.env).remove(scope, material.documentPath);
      } catch (error) {
        logServerError("materials.delete.concept", error);
        return c.json({ error: "Could not remove the knowledge document. Try deleting again." }, 503);
      }
    }
    const removed = await deleteMaterial(db, scope, materialId);
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
  });
}

/** Re-runs tier-1 conversion against the stored bytes. For a format the
 *  pipeline still cannot extract this is honestly a no-op -- it re-reports
 *  `pending` with the same reason rather than pretending a retry helped,
 *  which is why the response says which happened. */
export async function reingestMaterialHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const materialId = c.req.param("materialId");
  if (!materialId) return c.json({ error: "No such material." }, 404);

  const db = makeDb(c.env.DATABASE_URL);
  const material = await getMaterialForReingest(db, scope, materialId);
  if (!material || !material.storageKey || !material.originalFilename) {
    return c.json({ error: "No such material." }, 404);
  }

  const bytes = await storageFromEnv(c.env).get(material.storageKey);
  if (!bytes) {
    await setMaterialStatus(db, scope, materialId, "failed", "The stored file is missing.");
    return c.json({ error: "The stored file is missing." }, 404);
  }

  // OCR can take minutes. Return promptly and let the existing UI poll.
  if (extensionOf(material.originalFilename) === "pdf") {
    await setMaterialStatus(db, scope, materialId, "pending", null);
    scheduleExtraction({ db, courseId: scope, materialId,
      filename: material.originalFilename, relativePath: material.relativePath, bytes,
      ocr: ocrOptionsFromEnv(c.env), knowledge: knowledgeServiceFromEnv(c.env),
      existingDocumentPath: material.documentPath });
    return c.json({ status: "pending", documentCreated: false }, 202);
  }

  // Reingest runs synchronously (unlike upload's scheduleExtraction): the
  // instructor is waiting on this button and wants the outcome in the
  // response, not a pending status to poll.
  const result = await extractMaterial({
    db,
    courseId: scope,
    materialId,
    filename: material.originalFilename,
    relativePath: material.relativePath,
    bytes,
    ocr: ocrOptionsFromEnv(c.env),
    knowledge: knowledgeServiceFromEnv(c.env),
    existingDocumentPath: material.documentPath,
  });
  return c.json({
    status: result.status,
    documentCreated: result.documentPath !== null && result.documentPath !== material.documentPath,
  });
}

/** RFC 6266 / 5987: an ASCII fallback plus the UTF-8 form, so a file named in
 *  another script or with spaces still downloads under its own name. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The original upload, byte for byte, under its own name and type. */
export async function downloadMaterialHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const materialId = c.req.param("materialId");
  if (!materialId) return c.json({ error: "No such material." }, 404);
  const material = await getMaterialForReingest(makeDb(c.env.DATABASE_URL), scope, materialId);
  if (!material || !material.storageKey || !material.originalFilename) {
    return c.json({ error: "No such material." }, 404);
  }
  const bytes = await storageFromEnv(c.env).get(material.storageKey);
  if (!bytes) return c.json({ error: "The stored file is missing." }, 404);
  return c.body(bytes, 200, {
    "Content-Type": material.contentType ?? "application/octet-stream",
    "Content-Disposition": attachmentDisposition(material.originalFilename),
    "Cache-Control": "no-store",
  });
}
