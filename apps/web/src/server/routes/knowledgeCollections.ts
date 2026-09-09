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
import { z } from "zod";
import { makeDb } from "../../db/client";
import type { AppEnv } from "../context";
import { instructorScope } from "../utils/guards";
import {
  attachCollection,
  createCollection,
  deleteCollection,
  detachCollection,
  listAttachments,
  listCollections,
  listDocumentsInCollections,
  resolveForTarget,
  setCollectionItems,
  updateCollection,
} from "../repositories/knowledgeCollections";
import type {
  AttachmentListPayload,
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

export async function listCollectionsHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const collections = await listCollections(makeDb(c.env.DATABASE_URL), scope);
  return c.json({ collections } satisfies CollectionListPayload);
}

export async function createCollectionHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "A collection needs a name." }, 400);

  const membershipId = membershipIdOf(c, scope);
  if (!membershipId) return c.json({ error: "Not permitted." }, 403);

  try {
    const created = await createCollection(makeDb(c.env.DATABASE_URL), scope, {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      createdById: membershipId,
    });
    return c.json(created, 201);
  } catch {
    return c.json({ error: "A collection with that name already exists." }, 409);
  }
}

export async function updateCollectionHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return c.json({ error: "No such collection." }, 404);

  const parsed = writeSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid collection." }, 400);

  const updated = await updateCollection(makeDb(c.env.DATABASE_URL), scope, collectionId, parsed.data);
  return updated ? c.json(updated) : c.json({ error: "No such collection." }, 404);
}

export async function deleteCollectionHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return c.json({ error: "No such collection." }, 404);

  const removed = await deleteCollection(makeDb(c.env.DATABASE_URL), scope, collectionId);
  return removed ? c.body(null, 204) : c.json({ error: "No such collection." }, 404);
}

export async function setCollectionItemsHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return c.json({ error: "No such collection." }, 404);

  const parsed = itemsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Each item names exactly one of documentId or directoryPath." }, 400);
  }

  const ok = await setCollectionItems(
    makeDb(c.env.DATABASE_URL),
    scope,
    collectionId,
    parsed.data.items as Parameters<typeof setCollectionItems>[3],
  );
  return ok ? c.body(null, 204) : c.json({ error: "No such collection." }, 404);
}

export async function listAttachmentsHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);
  const attachments = await listAttachments(makeDb(c.env.DATABASE_URL), scope);
  return c.json({ attachments } satisfies AttachmentListPayload);
}

export async function attachCollectionHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const collectionId = c.req.param("collectionId");
  if (!collectionId) return c.json({ error: "No such collection." }, 404);

  const parsed = scopeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid attachment scope." }, 400);
  const attachmentScope = parsed.data.scope;

  // A course-scoped attachment may only name THIS course. Without this the
  // scope column would be a caller-supplied course id that the tenancy guard
  // on course_id never sees.
  if (attachmentScope.kind === "course" && attachmentScope.courseId !== scope) {
    return c.json({ error: "A course attachment must name this course." }, 400);
  }

  const ok = await attachCollection(makeDb(c.env.DATABASE_URL), scope, collectionId, attachmentScope);
  return ok ? c.body(null, 204) : c.json({ error: "No such collection." }, 404);
}

export async function detachCollectionHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const attachmentId = c.req.param("attachmentId");
  if (!attachmentId) return c.json({ error: "No such attachment." }, 404);

  const ok = await detachCollection(makeDb(c.env.DATABASE_URL), scope, attachmentId);
  return ok ? c.body(null, 204) : c.json({ error: "No such attachment." }, 404);
}

export async function resolveKnowledgeHandler(c: Context<AppEnv>) {
  const scope = instructorScope(c);
  if (!scope) return c.json({ error: "Not permitted." }, 403);

  const db = makeDb(c.env.DATABASE_URL);
  const resolution = await resolveForTarget(db, scope, {
    courseId: scope,
    homeworkId: c.req.query("homeworkId") ?? null,
    sectionId: c.req.query("sectionId") ?? null,
    llmConfigId: c.req.query("llmConfigId") ?? null,
  });

  // No attachments means no documents; skip the expansion query entirely.
  const documents =
    resolution.collectionIds.length === 0
      ? []
      : await listDocumentsInCollections(db, scope, resolution.collectionIds);

  return c.json({ ...resolution, documents } as ResolutionPayload);
}
