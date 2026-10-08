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
import { Effect } from "effect";
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
import type { CourseScope } from "../repositories/scope";
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
import { BadRequest, ExternalServiceError, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { Database, external, query } from "../effect/services";
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

/** instructorScope() (see the header) as a typed refusal. */
function requireInstructorScope(c: Context<AppEnv>): Effect.Effect<CourseScope, Forbidden> {
  const scope = instructorScope(c);
  return scope ? Effect.succeed(scope) : Effect.fail(new Forbidden({ message: "Not permitted." }));
}

const noSuchMaterial = () => new NotFound({ message: "No such material." });

/** knowledgeServiceFromEnv throws KnowledgeNotConfiguredError when
 *  KNOWLEDGE_ROOT is unset; that, like any knowledge outage, is a logged 503. */
function knowledgeService(c: Context<AppEnv>) {
  return Effect.try({
    try: () => knowledgeServiceFromEnv(c.env),
    catch: (cause) => new ExternalServiceError({ service: "knowledge", operation: "knowledgeServiceFromEnv", cause }),
  });
}

/** Runs `effect` under withMaterialLock (shared with extraction), keeping its
 *  typed failures: the lock is promise-based, so the effect runs to an Exit
 *  inside it and that Exit is replayed outside. */
function underMaterialLock<A, E, R>(
  courseId: string,
  materialId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.flatMap(Effect.context<R>(), (context) =>
    Effect.flatten(Effect.promise(() =>
      withMaterialLock(courseId, materialId, () => Effect.runPromiseExitWith(context)(effect)))));
}

export const listMaterialsHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const materials = yield* query("listMaterialsForCourse", async (db) => listMaterialsForCourse(db, scope));
  return c.json({ materials } satisfies MaterialListPayload);
}));

export const uploadMaterialHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  // A body that is not parseable multipart (wrong content type, truncated
  // stream) is the client's malformed request -- it used to fall through to
  // the generic 503 as if the server were down.
  const form = yield* Effect.tryPromise({
    try: () => c.req.formData(),
    catch: () => new BadRequest({ message: "No file was uploaded." }),
  });
  const file = form.get("file");
  if (!(file instanceof File)) {
    return yield* new BadRequest({ message: "No file was uploaded." });
  }

  const relativePathRaw = form.get("relativePath");
  const relativePath =
    typeof relativePathRaw === "string" && relativePathRaw.length > 0 && relativePathRaw.length <= 400 &&
    !relativePathRaw.split("/").some((s) => s === "" || s === "." || s === "..")
      ? relativePathRaw
      : null;
  if (typeof relativePathRaw === "string" && relativePathRaw.length > 0 && relativePath === null) {
    return yield* new BadRequest({ message: "Invalid relativePath." });
  }

  const extension = extensionOf(file.name);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    return yield* new BadRequest({
      message: `Unsupported file type ".${extension}". Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`,
    });
  }
  // 413 is not one of the bridge's request outcomes, so it stays a Response.
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
  if (!membershipId) return yield* new Forbidden({ message: "Not permitted." });

  const bytes = yield* Effect.promise(() => file.arrayBuffer());
  const checksum = yield* Effect.promise(() => sha256Hex(bytes));

  // Insert first: the row's id is part of the storage key, so a stored
  // object always has a row that names it. The reverse order can strand an
  // object nothing references.
  //
  // The row starts at `pending` unconditionally now: extraction runs after
  // this handler returns (scheduleExtraction, below), so nothing here yet
  // knows whether the format is supported or the concept write will land.
  const material = yield* query("insertMaterial", async (db) => insertMaterial(db, scope, {
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
  }));

  const key = materialStorageKey(scope, material.id, file.name);
  // Every put failure -- a StorageError, an unconfigured store
  // (StorageNotConfiguredError), a network fault -- removes the row and
  // answers here, so it is captured as a value rather than left to the
  // bridge's generic 503.
  const putFailure = yield* external(
    "storage",
    "putMaterial",
    async () => storageFromEnv(c.env).put(key, bytes, { contentType: file.type || undefined }),
    [StorageError],
  ).pipe(
    Effect.as(null),
    Effect.catch((error) => Effect.succeed(error)),
  );
  if (putFailure) {
    logServerError("materials.upload", putFailure._tag === "ExternalServiceError" ? putFailure.cause : putFailure);
    yield* query("deleteMaterial", async (db) => deleteMaterial(db, scope, material.id));
    // StorageError carries the status structurally so a throttle is not
    // reported as a dead end. Neon answers 503 SlowDown under load; telling
    // an instructor "could not store the uploaded file" when trying again
    // would have worked is the failure this distinction exists to prevent.
    if (putFailure._tag === "StorageError" && putFailure.retryable) {
      return c.json(
        { error: "Storage is busy right now. Try uploading again in a moment." },
        503,
      );
    }
    // 502 is not one of the bridge's request outcomes, so it stays a Response.
    return c.json({ error: "Could not store the uploaded file." }, 502);
  }
  yield* query("setMaterialStorageKey", async (db) => setMaterialStorageKey(db, scope, material.id, key));

  // Extraction runs off the request path: on Node there is no per-request
  // CPU cap, so this enqueues the write rather than making the instructor
  // wait on it synchronously. The handler answers 201 pending immediately;
  // the console polls status.
  //
  // The queue runs two jobs at a time (extract/job.ts), so the memory held
  // by queued upload bytes is bounded by what this instructor has uploaded
  // and not yet had extracted -- not, as before the queue, by every upload
  // being decompressed at once.
  const db = yield* Database;
  const knowledge = yield* knowledgeService(c);
  scheduleExtraction({
    db,
    courseId: scope,
    materialId: material.id,
    filename: file.name,
    relativePath,
    bytes,
    ocr: ocrOptionsFromEnv(c.env),
    knowledge,
    existingDocumentPath: null,
  });

  return c.json({ id: material.id, status: "pending" }, 201);
}));

export const deleteMaterialHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const materialId = c.req.param("materialId");
  if (!materialId) return yield* noSuchMaterial();

  return yield* underMaterialLock(scope, materialId, Effect.gen(function* () {
    const material = yield* query("getMaterialForReingest", async (db) => getMaterialForReingest(db, scope, materialId));
    if (!material) return yield* noSuchMaterial();
    // Retrieval uses the filesystem, so remove grounding before deleting
    // its retry handle in Postgres. A failed removal must remain retryable.
    const documentPath = material.documentPath;
    if (documentPath) {
      const removeFailure = yield* knowledgeService(c).pipe(
        Effect.flatMap((knowledge) =>
          external("knowledge", "removeConcept", async () => knowledge.remove(scope, documentPath))),
        Effect.as(null),
        Effect.catchTag("ExternalServiceError", (error) => Effect.succeed(error)),
      );
      if (removeFailure) {
        logServerError("materials.delete.concept", removeFailure.cause);
        return c.json({ error: "Could not remove the knowledge document. Try deleting again." }, 503);
      }
    }
    const removed = yield* query("deleteMaterial", async (db) => deleteMaterial(db, scope, materialId));
    if (!removed) return yield* noSuchMaterial();

    const storageKey = removed.storageKey;
    if (storageKey) {
      // Best effort: the row is already gone, and a stranded object is a
      // cleanup problem rather than a correctness one.
      yield* external("storage", "deleteMaterial", async () => storageFromEnv(c.env).delete(storageKey)).pipe(
        Effect.catchTag("ExternalServiceError", (error) =>
          Effect.sync(() => logServerError("materials.delete.storage", error.cause))),
      );
    }
    return c.body(null, 204);
  }));
}));

/** Re-runs tier-1 conversion against the stored bytes. For a format the
 *  pipeline still cannot extract this is honestly a no-op -- it re-reports
 *  `pending` with the same reason rather than pretending a retry helped,
 *  which is why the response says which happened. */
export const reingestMaterialHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const materialId = c.req.param("materialId");
  if (!materialId) return yield* noSuchMaterial();

  const material = yield* query("getMaterialForReingest", async (db) => getMaterialForReingest(db, scope, materialId));
  if (!material || !material.storageKey || !material.originalFilename) {
    return yield* noSuchMaterial();
  }
  const { storageKey, originalFilename } = material;

  const bytes = yield* external("storage", "getMaterial", async () => storageFromEnv(c.env).get(storageKey));
  if (!bytes) {
    yield* query("setMaterialStatus", async (db) =>
      setMaterialStatus(db, scope, materialId, "failed", "The stored file is missing."));
    return yield* new NotFound({ message: "The stored file is missing." });
  }

  // OCR can take minutes. Return promptly and let the existing UI poll.
  if (extensionOf(originalFilename) === "pdf") {
    yield* query("setMaterialStatus", async (db) => setMaterialStatus(db, scope, materialId, "pending", null));
    const db = yield* Database;
    const knowledge = yield* knowledgeService(c);
    scheduleExtraction({ db, courseId: scope, materialId,
      filename: originalFilename, relativePath: material.relativePath, bytes,
      ocr: ocrOptionsFromEnv(c.env), knowledge,
      existingDocumentPath: material.documentPath });
    return c.json({ status: "pending", documentCreated: false }, 202);
  }

  // Reingest runs synchronously (unlike upload's scheduleExtraction): the
  // instructor is waiting on this button and wants the outcome in the
  // response, not a pending status to poll.
  //
  // extractMaterial records its own extraction/knowledge failures on the row
  // and resolves "failed"; only its database calls can reject, so it runs
  // through query.
  const knowledge = yield* knowledgeService(c);
  const result = yield* query("extractMaterial", async (db) => extractMaterial({
    db,
    courseId: scope,
    materialId,
    filename: originalFilename,
    relativePath: material.relativePath,
    bytes,
    ocr: ocrOptionsFromEnv(c.env),
    knowledge,
    existingDocumentPath: material.documentPath,
  }));
  return c.json({
    status: result.status,
    documentCreated: result.documentPath !== null && result.documentPath !== material.documentPath,
  });
}));

/** RFC 6266 / 5987: an ASCII fallback plus the UTF-8 form, so a file named in
 *  another script or with spaces still downloads under its own name. */
function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The original upload, byte for byte, under its own name and type. */
export const downloadMaterialHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const materialId = c.req.param("materialId");
  if (!materialId) return yield* noSuchMaterial();
  const material = yield* query("getMaterialForReingest", async (db) => getMaterialForReingest(db, scope, materialId));
  if (!material || !material.storageKey || !material.originalFilename) {
    return yield* noSuchMaterial();
  }
  const { storageKey, originalFilename } = material;
  const bytes = yield* external("storage", "getMaterial", async () => storageFromEnv(c.env).get(storageKey));
  if (!bytes) return yield* new NotFound({ message: "The stored file is missing." });
  return c.body(bytes, 200, {
    "Content-Type": material.contentType ?? "application/octet-stream",
    "Content-Disposition": attachmentDisposition(originalFilename),
    "Cache-Control": "no-store",
  });
}));
