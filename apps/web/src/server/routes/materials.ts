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
  const converted = convertToOkf(file.name, bytes);
  const db = makeDb(c.env.DATABASE_URL);

  // Insert first: the row's id is part of the storage key, so a stored
  // object always has a row that names it. The reverse order can strand an
  // object nothing references.
  //
  // The row starts PESSIMISTIC -- `pending` even for a format that converted
  // cleanly -- and is upgraded to `ready` only once the bytes are stored and
  // the document exists. Writing `ready` up front and rolling back on
  // failure is only correct while the rollback is: if that delete throws,
  // the row survives claiming the tutor can use content that was never
  // stored. Any interruption here instead leaves `pending`, which is
  // honest, because pending means "not ready" and that is true.
  const material = await insertMaterial(db, scope, {
    title: file.name.replace(/\.[^.]+$/, ""),
    sourceType: sourceTypeFor(file.name),
    originalFilename: file.name,
    storageKey: "",
    byteSize: file.size,
    contentType: file.type || null,
    checksum,
    status: "pending",
    errorDetail: converted
      ? null
      : `Text extraction for .${extension} is not implemented yet (#40). Upload stored; author a document manually to ground on it.`,
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

  if (converted) {
    await createDocument(db, scope, {
      path: converted.title.replace(/[^A-Za-z0-9._/-]/g, "-"),
      kind: "concept",
      type: converted.type,
      title: converted.title,
      body: converted.markdown,
      bodyOriginal: converted.markdown,
      sourceMaterialId: material.id,
      editedById: membershipId,
    });
    // Everything the status asserts is now true: the bytes are stored and
    // the document exists. Only now does it claim `ready`.
    await setMaterialStatus(db, scope, material.id, "ready", null);
  }

  return c.json({ id: material.id, status: converted ? "ready" : "pending" }, 201);
}

export async function deleteMaterialHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const materialId = c.req.param("materialId");
  if (!materialId) return c.json({ error: "No such material." }, 404);

  const db = makeDb(c.env.DATABASE_URL);
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

  const membershipId = membershipIdOf(c, scope);
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
