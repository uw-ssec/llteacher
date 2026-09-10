/* --------------------------------------------------------------------------
   The bundle's documents (#42).

   Path validation is the security-relevant part of this file. `path` becomes
   a database identity and is rendered into markdown links, so a traversal
   segment or a leading slash is refused here rather than normalised --
   silently rewriting a caller's path produces a document at an address they
   did not ask for, which is worse than an error.

   Creating a FOLDER means creating its index document: OKF has no directory
   entity, directories are implicit in paths, and an index document is both
   the format's directory listing and the thing that keeps an empty folder
   alive across a reload.

   These are instructor-authoring routes (plan invariant: every course route
   nests under requireInstructorOf()). Task 17 wraps registration in that
   guard too, but instructorScope() (utils/guards.ts) checks isInstructorOf
   directly rather than relying solely on that wrapper, so a handler called
   on its own -- as this file's own tests do -- still refuses a student.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import { z } from "zod";
import { makeDb } from "../../db/client";
import type { Db } from "../../db/client";
import type { AppEnv } from "../context";
import { instructorScope } from "../utils/guards";
import { appendLogEntry, directoryOf, parentDirectories, renderIndex } from "../knowledge/bundle";
import {
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentLinks,
  listDocuments,
  updateDocumentBody,
} from "../repositories/knowledgeDocuments";
import type { CourseScope } from "../repositories/scope";
import { logServerError } from "../utils/errors";
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

function membershipIdOf(c: Context<AppEnv>, courseId: string): string | null {
  return c.get("authContext")?.memberships.find((m) => m.courseId === courseId)?.id ?? null;
}

/** Regenerates the index documents a change invalidates, and appends one
 *  dated log line. Best-effort and deliberately after the response-shaping
 *  work: a failed housekeeping write should not fail an otherwise-good
 *  create, and the next change repairs it. Errors are caught at each call
 *  site (not here) so a test -- and a reviewer -- can see exactly where the
 *  "best effort" boundary is.
 *
 *  `isoDate` is passed in rather than read from the clock here, matching
 *  bundle.ts -- the date is data, so the whole path stays testable. */
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

/** Wraps maintainBundle so a housekeeping failure never turns an
 *  otherwise-good create or delete into a client-visible failure (see the
 *  doc comment above). The next change to the bundle repairs whatever this
 *  attempt failed to write. */
async function maintainBundleBestEffort(
  db: Db,
  scope: CourseScope,
  changedPath: string,
  message: string,
  isoDate: string,
): Promise<void> {
  try {
    await maintainBundle(db, scope, changedPath, message, isoDate);
  } catch (error) {
    logServerError("knowledgeDocuments.maintainBundle", error);
  }
}

export async function listDocumentsHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const documents = await listDocuments(makeDb(c.env.DATABASE_URL), scope);
  return c.json({ documents } satisfies KnowledgeDocumentListPayload);
}

export async function createDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
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
  let created;
  try {
    created = await createDocument(db, scope, {
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
  } catch {
    // The only constraint a well-formed request can hit is the path unique
    // index; everything else was validated above.
    return c.json({ error: "A document already exists at that path." }, 409);
  }

  await maintainBundleBestEffort(
    db,
    scope,
    path,
    `**Creation** Added \`${path}\`.`,
    new Date().toISOString().slice(0, 10),
  );

  return c.json(created, 201);
}

export async function getDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const documentId = c.req.param("documentId");
  if (!documentId) return c.json({ error: "No such document." }, 404);

  const document = await getDocument(makeDb(c.env.DATABASE_URL), scope, documentId);
  return document ? c.json(document) : c.json({ error: "No such document." }, 404);
}

export async function updateDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const documentId = c.req.param("documentId");
  if (!documentId) return c.json({ error: "No such document." }, 404);

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid document body." }, 400);

  const updated = await updateDocumentBody(makeDb(c.env.DATABASE_URL), scope, documentId, {
    body: parsed.data.body,
    editedById: membershipIdOf(c, scope),
  });
  return updated ? c.json(updated) : c.json({ error: "No such document." }, 404);
}

export async function deleteDocumentHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const documentId = c.req.param("documentId");
  if (!documentId) return c.json({ error: "No such document." }, 404);

  const db = makeDb(c.env.DATABASE_URL);
  const removed = await deleteDocument(db, scope, documentId);
  if (!removed) return c.json({ error: "No such document." }, 404);

  await maintainBundleBestEffort(
    db,
    scope,
    removed.path,
    `**Update** Removed \`${removed.path}\`.`,
    new Date().toISOString().slice(0, 10),
  );

  return c.body(null, 204);
}

export async function documentLinksHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const documentId = c.req.param("documentId");
  if (!documentId) return c.json({ error: "No such document." }, 404);

  const links = await getDocumentLinks(makeDb(c.env.DATABASE_URL), scope, documentId);
  return c.json(links satisfies DocumentLinksPayload);
}
