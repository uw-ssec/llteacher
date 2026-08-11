/* --------------------------------------------------------------------------
   /api/conversations — tutor conversation CRUD (#5).

   List/create/rename/delete for the free-standing, course-scoped "tutor"
   conversations #3's /api/chat auto-creates (kind: "tutor", sectionId:
   null) -- distinct from the section-scoped conversations a student works
   a specific homework Section through (kind: "section", #214), which a
   later task in this epic (#27) will add a `type` column to further
   distinguish on the wire. This route set doesn't anticipate that; `kind`
   here is the real conversations.kind enum column ("section" | "tutor")
   that already exists.

   Ownership pattern follows chat.ts (#3): GET/POST verify course membership
   via courseScopeFromAuthContext (the only sanctioned way to mint a
   CourseScope from request input); PATCH/DELETE take just a conversation id
   with no courseId in the URL, so they share getOwnedConversationOrNull
   (repositories/conversations.ts, moved there so chat.ts can reuse the
   identical rule -- #217), which fetches the row via the unscoped
   getConversationById and manually compares ownerUserId against the caller.
   Every "not found or not owned" case returns 404 (never 401/403) so a
   guessed/leaked conversation id can't be used to confirm one exists that
   isn't the caller's. A separate 404 path: createConversation
   (repositories/conversations.ts) throws a typed TenancyMismatchError on
   its own tenancy check (owner/section not in scope), mapped to 404 by
   app.onError (server/index.ts, #141) -- a single app-layer mapping point,
   not a per-route catch here.
   -------------------------------------------------------------------------- */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { makeDb } from "../../db/client";
import {
  listConversationsForOwner,
  createConversation,
  updateConversationTitle,
  softDeleteConversation,
  getOwnedConversationOrNull,
  getMessagesForConversation,
} from "../repositories/conversations";
import { courseScopeFromAuthContext, unsafeCourseScope } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { ConversationSummary, ConversationListItemResponse, ConversationMessageResponse } from "../../shared/types";

const createConversationSchema = z.object({
  courseId: z.string().uuid(),
  title: z.string().trim().min(1).max(100).optional(),
});

const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(100),
});

// #218: projects a raw `conversations` row to the wire contract -- drops
// ownerUserId/courseId/sectionId/isDeleted/deletedAt, none of which any
// client reads (see ConversationSummary's doc comment, shared/types.ts).
function toConversationSummary(row: {
  id: string;
  kind: "section" | "tutor";
  title: string;
  createdAt: Date;
  updatedAt: Date;
}): ConversationSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listConversationsHandler(c: Context<AppEnv>) {
  // authMiddleware/rolesMiddleware already gate every /api/* route (this
  // route is wired in unguarded via app.get("/api/conversations", ...) in
  // server/index.ts, same as chat.ts) -- re-checked here so a direct call to
  // this handler (as the unit tests below do) fails closed with a 401
  // instead of throwing on authContext.session below.
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const courseId = c.req.query("courseId");
  if (!courseId) {
    return c.json({ error: "courseId is required" }, 400);
  }

  // Defaults to "tutor": this route's own doc comment above and the client
  // this backs (#27's list surface) only ever ask for tutor conversations
  // today, but the enum genuinely has a second value ("section"), so this
  // is a real filter, not a no-op -- validated against both known values
  // rather than passed through unchecked to the repository's `eq`.
  const kind = c.req.query("kind") ?? "tutor";
  if (kind !== "tutor" && kind !== "section") {
    return c.json({ error: "kind must be 'tutor' or 'section'" }, 400);
  }

  // #224: optional pagination. `limit` clamped to a sane range rather than
  // trusted verbatim -- a client-supplied 1000000 would defeat the point of
  // bounding the page. `before` is an updatedAt cursor (ISO timestamp): the
  // caller passes back the last row's updatedAt to fetch the next page.
  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
    }
    limit = parsed;
  }
  const beforeParam = c.req.query("before");
  let before: Date | undefined;
  if (beforeParam !== undefined) {
    const parsed = new Date(beforeParam);
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ error: "before must be a valid ISO timestamp" }, 400);
    }
    before = parsed;
  }

  // The only sanctioned way to mint a CourseScope from request input (see
  // scope.ts's courseScopeFromAuthContext docstring) -- verifies the caller
  // is actually a member of courseId before this can proceed.
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const rows = await listConversationsForOwner(db, scope, authContext.session.userId, { kind, limit, before });
  const body: ConversationListItemResponse[] = rows.map((r) => ({
    ...toConversationSummary(r),
    messageCount: r.messageCount,
  }));
  return c.json(body);
}

export async function createConversationHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  // safeParse + a hand-written message (not the raw zod issue) -- matches
  // chat.ts's inboundUserMessageSchema convention rather than surfacing zod's
  // internal error shape to the client.
  const parsed = createConversationSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "courseId (uuid) is required; title, if present, must be 1-100 chars" }, 400);
  }

  const scope = courseScopeFromAuthContext(authContext, parsed.data.courseId);
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  // createConversation (repositories/conversations.ts, #3) re-verifies
  // course membership itself (courseScopeFromAuthContext already did, but
  // the repository doesn't trust callers to have checked) and throws a
  // typed TenancyMismatchError on a mismatch -- app.onError (server/
  // index.ts) maps that to a 404 (#141), not the generic 503 every other
  // uncaught error gets. Same call shape as chatHandler's new-conversation
  // branch (routes/chat.ts).
  const created = await createConversation(db, scope, {
    ownerUserId: authContext.session.userId,
    sectionId: null,
    kind: "tutor",
    title: parsed.data.title || "New Conversation",
  });

  return c.json(toConversationSummary(created), 201);
}

export async function updateConversationHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.req.param("id");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  const parsed = updateConversationSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "title is required and must be 1-100 chars after trimming" }, 400);
  }

  const db = makeDb(c.env.DATABASE_URL);

  const existing = await getOwnedConversationOrNull(db, id!, authContext.session.userId);
  if (!existing) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  // Row just read back and ownership-checked -- the sanctioned case for
  // this cast per scope.ts's unsafeCourseScope docstring.
  const scope = unsafeCourseScope(existing.courseId);
  const updated = await updateConversationTitle(db, scope, id!, parsed.data.title);
  // updateConversationTitle also excludes soft-deleted rows -- a
  // conversation deleted between the check above and this write (or one
  // that was already soft-deleted) 404s here too, same bucket as "not
  // found".
  if (!updated) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  return c.json(toConversationSummary(updated));
}

export async function deleteConversationHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.req.param("id");
  const db = makeDb(c.env.DATABASE_URL);

  const existing = await getOwnedConversationOrNull(db, id!, authContext.session.userId);
  if (!existing) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  const scope = unsafeCourseScope(existing.courseId);
  // Soft delete (isDeleted/deletedAt), not a hard DELETE FROM: conversations
  // already has this exact mechanism (softDeleteConversation, added when
  // the schema landed) and listConversationsForOwner already excludes
  // soft-deleted rows by default, so the conversation and its messages
  // disappear from every read path this task's requirements care about
  // without an irreversible hard delete. A literal hard delete would also
  // conflict with llm_call_logs.conversation_id's ON DELETE RESTRICT FK
  // (runtime.ts) the moment a tutor conversation has any logged model
  // call -- soft delete has no such failure mode. Messages are left in
  // place (not separately deleted): nothing reads messages for a
  // soft-deleted conversation once its parent conversation is filtered out,
  // and the FK is ON DELETE CASCADE from conversations.id for the day a
  // real hard-delete/purge path is added.
  await softDeleteConversation(db, scope, id!);

  return c.body(null, 204);
}

// #4 fix-round: GET /api/conversations/:id/messages -- added after code
// review found that TutorConversationsList selecting an *existing*
// conversation reset the client's chat to empty with no way to reseed it,
// which wasn't just a visual gap: chatHandler (chat.ts) builds the model's
// context from convertToModelMessages(uiMessages), the array the CLIENT
// sends, so an empty client-side history meant the LLM had actually lost
// every prior turn, not just the UI. Same ownership pattern as PATCH/DELETE
// above (getOwnedConversationOrNull -> 404, never 403, on "doesn't exist or
// isn't yours") rather than a new one.
export async function listConversationMessagesHandler(c: Context<AppEnv>) {
  const authContext = c.get("authContext") as AuthContext | undefined;
  if (!authContext) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.req.param("id");
  const db = makeDb(c.env.DATABASE_URL);

  const existing = await getOwnedConversationOrNull(db, id!, authContext.session.userId);
  if (!existing) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  // #215: bounded page (limit/before -- a seq cursor), not the entire
  // conversation. Same clamp shape as the list route's `limit` above.
  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return c.json({ error: "limit must be an integer between 1 and 500" }, 400);
    }
    limit = parsed;
  }
  const beforeParam = c.req.query("before");
  let before: number | undefined;
  if (beforeParam !== undefined) {
    const parsed = Number(beforeParam);
    if (!Number.isInteger(parsed)) {
      return c.json({ error: "before must be an integer seq value" }, 400);
    }
    before = parsed;
  }

  const scope = unsafeCourseScope(existing.courseId);
  const rows = await getMessagesForConversation(db, scope, id!, { limit, before });
  // #226: the shape is checked against ConversationMessageResponse now
  // (previously an untyped literal the client asserted a different type
  // over -- neither side of the wire boundary actually enforced it). `parts`
  // stays `unknown`, matching how it's stored (jsonb) and how chat.ts's own
  // replayPersistedPart already treats a persisted row's parts at this same
  // boundary.
  const body: ConversationMessageResponse[] = rows.map((r) => ({ id: r.id, role: r.role, parts: r.parts }));
  return c.json(body);
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post/patch/delete("/api/conversations...", ...) in server/index.ts.
export const conversationsRoutes = new Hono<AppEnv>();
conversationsRoutes.get("/", listConversationsHandler);
conversationsRoutes.post("/", createConversationHandler);
conversationsRoutes.get("/:id/messages", listConversationMessagesHandler);
conversationsRoutes.patch("/:id", updateConversationHandler);
conversationsRoutes.delete("/:id", deleteConversationHandler);
