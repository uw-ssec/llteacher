/* --------------------------------------------------------------------------
   Collections, attachments, and the resolve endpoint (#42).

   resolveKnowledgeHandler is the one worth reading twice. It answers "what
   will the tutor actually see here", and it exists so the override rule is
   VISIBLE in the console rather than something an instructor has to
   reconstruct from four attachment lists. It returns the deciding `level`
   alongside the collections, because "your section attachment silently
   replaced the course readings" is the failure mode of most-specific-wins
   and the UI needs to be able to say so.

   Retrieval (#41) will call resolveForTarget directly. Both paths go through
   the same pure function, so the console cannot show one answer while the
   tutor uses another.
   -------------------------------------------------------------------------- */

import type { Context } from "hono";
import { Effect } from "effect";
import { z } from "zod";
import type { AppEnv } from "../context";
import { instructorScope } from "../utils/guards";
import {
  attachCollection,
  CollectionNameExistsError,
  createCollection,
  deleteCollection,
  detachCollection,
  getCollectionItems,
  homeworkBelongsToCourse,
  listAttachments,
  listCollections,
  listDocumentsInCollections,
  resolveForTarget,
  sectionBelongsToCourse,
  setCollectionItems,
  updateCollection,
} from "../repositories/knowledgeCollections";
import type { CourseScope } from "../repositories/scope";
import { BadRequest, Conflict, Forbidden, NotFound } from "../effect/errors";
import { effectHandler } from "../effect/http";
import { query } from "../effect/services";
import type {
  AttachmentListPayload,
  CollectionItemsPayload,
  CollectionListPayload,
  ResolutionPayload,
} from "@llteacher/ui/api";

const writeSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
});

/** Exactly one target, mirroring the collection_items CHECK. A body naming
 *  both is a caller bug and is refused rather than silently preferring one. */
const itemSchema = z
  .object({
    documentId: z.string().uuid().optional(),
    directoryPath: z.string().min(1).max(400).optional(),
  })
  .refine((v) => !!v.documentId !== !!v.directoryPath, {
    message: "An item names exactly one of documentId or directoryPath.",
  });

const itemsSchema = z.object({ items: z.array(itemSchema).max(500) });

const scopeSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("course"), courseId: z.string().uuid() }),
    z.object({ kind: z.literal("homework"), homeworkId: z.string().uuid() }),
    z.object({ kind: z.literal("section"), sectionId: z.string().uuid() }),
    z.object({ kind: z.literal("llmConfig"), llmConfigId: z.string().uuid() }),
  ]),
});

function membershipIdOf(c: Context<AppEnv>, courseId: string): string | null {
  return c.get("authContext")?.memberships.find((m) => m.courseId === courseId)?.id ?? null;
}

/** instructorScope() as a typed refusal. */
function requireInstructorScope(c: Context<AppEnv>): Effect.Effect<CourseScope, Forbidden> {
  const scope = instructorScope(c);
  return scope ? Effect.succeed(scope) : Effect.fail(new Forbidden({ message: "Not permitted." }));
}

const readJson = (c: Context<AppEnv>) => Effect.promise(() => c.req.json().catch(() => null));

const noSuchCollection = () => new NotFound({ message: "No such collection." });

const nameTaken = () => Effect.fail(new Conflict({ message: "A collection with that name already exists." }));

export const listCollectionsHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const collections = yield* query("listCollections", async (db) => listCollections(db, scope));
  return c.json({ collections } satisfies CollectionListPayload);
}));

export const createCollectionHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const parsed = writeSchema.safeParse(yield* readJson(c));
  if (!parsed.success) return yield* new BadRequest({ message: "A collection needs a name." });

  const membershipId = membershipIdOf(c, scope);
  if (!membershipId) return yield* new Forbidden({ message: "Not permitted." });

  // Only the unique-name violation is a 409. This used to be a bare catch
  // that answered every failure -- an outage included -- as "name taken".
  const created = yield* query(
    "createCollection",
    async (db) => createCollection(db, scope, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      createdById: membershipId,
    }),
    [CollectionNameExistsError],
  ).pipe(Effect.catchTags({ CollectionNameExistsError: nameTaken }));
  return c.json(created, 201);
}));

export const updateCollectionHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return yield* noSuchCollection();

  const parsed = writeSchema.partial().safeParse(yield* readJson(c));
  if (!parsed.success) return yield* new BadRequest({ message: "Invalid collection." });

  const updated = yield* query(
    "updateCollection",
    async (db) => updateCollection(db, scope, collectionId, parsed.data),
    [CollectionNameExistsError],
  ).pipe(Effect.catchTags({ CollectionNameExistsError: nameTaken }));
  return updated ? c.json(updated) : yield* noSuchCollection();
}));

export const deleteCollectionHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return yield* noSuchCollection();

  const removed = yield* query("deleteCollection", async (db) => deleteCollection(db, scope, collectionId));
  return removed ? c.body(null, 204) : yield* noSuchCollection();
}));

/** The read half of setCollectionItemsHandler. The editor needs this to
 *  restore exactly what was selected before it can safely PUT again --
 *  without it, a save that only meant to add one folder would wholesale
 *  replace the collection's contents with just that folder. */
export const getCollectionItemsHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return yield* noSuchCollection();

  const items = yield* query("getCollectionItems", async (db) => getCollectionItems(db, scope, collectionId));
  return items ? c.json({ items } satisfies CollectionItemsPayload) : yield* noSuchCollection();
}));

export const setCollectionItemsHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return yield* noSuchCollection();

  const parsed = itemsSchema.safeParse(yield* readJson(c));
  if (!parsed.success) {
    return yield* new BadRequest({ message: "Each item names exactly one of documentId or directoryPath." });
  }

  const ok = yield* query("setCollectionItems", async (db) => setCollectionItems(
    db,
    scope,
    collectionId,
    parsed.data.items as Parameters<typeof setCollectionItems>[3],
  ));
  return ok ? c.body(null, 204) : yield* noSuchCollection();
}));

export const listAttachmentsHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);
  const attachments = yield* query("listAttachments", async (db) => listAttachments(db, scope));
  return c.json({ attachments } satisfies AttachmentListPayload);
}));

export const attachCollectionHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return yield* noSuchCollection();

  const parsed = scopeSchema.safeParse(yield* readJson(c));
  if (!parsed.success) return yield* new BadRequest({ message: "Invalid attachment scope." });
  const attachmentScope = parsed.data.scope;

  // A course-scoped attachment may only name THIS course. Without this the
  // scope column would be a caller-supplied course id that the tenancy guard
  // on course_id never sees.
  if (attachmentScope.kind === "course" && attachmentScope.courseId !== scope) {
    return yield* new BadRequest({ message: "A course attachment must name this course." });
  }

  // homework and section ids are foreign keys, but a foreign key only
  // proves the row exists SOMEWHERE -- not that it belongs to this course.
  // Every read path today filters by collection_attachments.course_id (the
  // acting course), so a mis-scoped row is inert rather than exposed -- but
  // it is still wrong data sitting in an authorization-adjacent table, and
  // the day something resolves by homeworkId/sectionId alone, that row
  // activates.
  if (attachmentScope.kind === "homework") {
    const homeworkId = attachmentScope.homeworkId;
    const belongs = yield* query("homeworkBelongsToCourse", async (db) => homeworkBelongsToCourse(db, scope, homeworkId));
    if (!belongs) return yield* new BadRequest({ message: "That homework does not belong to this course." });
  }
  if (attachmentScope.kind === "section") {
    const sectionId = attachmentScope.sectionId;
    const belongs = yield* query("sectionBelongsToCourse", async (db) => sectionBelongsToCourse(db, scope, sectionId));
    if (!belongs) return yield* new BadRequest({ message: "That section does not belong to this course." });
  }
  // llmConfig is deliberately NOT checked here: llm_configs is scoped by
  // organization_id, not course_id -- it has no course to belong to. A
  // tutor config is meant to be shared across a course's siblings, so a
  // course-equality check would be encoding a misunderstanding of the data
  // model, not closing a gap.

  const ok = yield* query("attachCollection", async (db) => attachCollection(db, scope, collectionId, attachmentScope));
  return ok ? c.body(null, 204) : yield* noSuchCollection();
}));

export const detachCollectionHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const attachmentId = c.req.param("attachmentId");
  if (!attachmentId) return yield* new NotFound({ message: "No such attachment." });

  const ok = yield* query("detachCollection", async (db) => detachCollection(db, scope, attachmentId));
  return ok ? c.body(null, 204) : yield* new NotFound({ message: "No such attachment." });
}));

export const resolveKnowledgeHandler = effectHandler((c) => Effect.gen(function* () {
  const scope = yield* requireInstructorScope(c);

  const resolution = yield* query("resolveForTarget", async (db) => resolveForTarget(db, scope, {
    courseId: scope,
    homeworkId: c.req.query("homeworkId") ?? null,
    sectionId: c.req.query("sectionId") ?? null,
    llmConfigId: c.req.query("llmConfigId") ?? null,
  }));

  // No attachments means no documents; skip the expansion query entirely.
  const documents =
    resolution.collectionIds.length === 0
      ? []
      : yield* query(
          "listDocumentsInCollections",
          async (db) => listDocumentsInCollections(db, scope, resolution.collectionIds),
        );

  return c.json({ ...resolution, documents } as ResolutionPayload);
}));
