/* --------------------------------------------------------------------------
   /api/conversations — tutor conversation CRUD (#5).

   List/create/rename/delete for the free-standing, course-scoped "tutor"
   conversations #3's /api/chat auto-creates (kind: "tutor", sectionId:
   null) -- distinct from the section-scoped conversations a student works
   a specific homework Section through, which a later task in this epic
   (#27) will add a `type` column to further distinguish on the wire. This
   route set doesn't anticipate that; `kind` here is the real
   conversations.kind enum column ("section" | "tutor") that already exists.

   Ownership pattern follows chat.ts (#3), not the CourseScope-only
   repository functions directly: GET/POST verify course membership via
   courseScopeFromAuthContext (the only sanctioned way to mint a CourseScope
   from request input); PATCH/DELETE take just a conversation id with no
   courseId in the URL, so they share getOwnedConversationOrNull below,
   which fetches the row via the unscoped getConversationById and manually
   compares ownerUserId against the caller, exactly like chatHandler's
   existing conversationId-ownership check. Every "not found or not owned"
   case returns 404 (never 403) so a guessed/leaked conversation id can't be
   used to confirm one exists that isn't the caller's -- centralized in that
   one helper rather than duplicated per handler. A separate 404 path:
   createConversation (repositories/conversations.ts) throws a typed
   TenancyMismatchError on its own tenancy check (owner/section not in
   scope), mapped to 404 by app.onError (server/index.ts, #141) -- a single
   app-layer mapping point, not a per-route catch here.
   -------------------------------------------------------------------------- */

import { Hono, type Context } from "hono";
import { z } from "zod";
import { makeDb, type Db } from "../../db/client";
import {
  listConversationsForOwner,
  createConversation,
  updateConversationTitle,
  softDeleteConversation,
  getConversationById,
  getMessagesForConversation,
} from "../repositories/conversations";
import { courseScopeFromAuthContext, unsafeCourseScope } from "../repositories/scope";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

const createConversationSchema = z.object({
  courseId: z.string().uuid(),
  title: z.string().trim().min(1).max(100).optional(),
});

const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(100),
});

// Shared "not found or not owned" check for PATCH/DELETE below: fetches via
// the unscoped getConversationById and compares ownerUserId against the
// caller, same pattern chatHandler (#3) established for conversationId
// ownership. Returns null for BOTH "doesn't exist" and "exists but isn't
// yours" -- callers must turn a null into a 404 (never 403), so a
// guessed/leaked conversation id can't be used to confirm one exists that
// isn't the caller's. Factored out (rather than duplicated in each handler,
// as it was until this was flagged in review). This is the route-level
// ownership check, not the repository-level tenancy check #141's
// TenancyMismatchError covers (see the file-level comment above) -- both
// converge on the same "404, never 403" rule, but through two different
// mechanisms.
async function getOwnedConversationOrNull(db: Db, conversationId: string, userId: string) {
  const existing = await getConversationById(db, conversationId);
  if (!existing || existing.ownerUserId !== userId) {
    return null;
  }
  return existing;
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

  // The only sanctioned way to mint a CourseScope from request input (see
  // scope.ts's courseScopeFromAuthContext docstring) -- verifies the caller
  // is actually a member of courseId before this can proceed.
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return c.json({ error: "Course access denied" }, 403);
  }

  const db = makeDb(c.env.DATABASE_URL);
  const rows = await listConversationsForOwner(db, scope, authContext.session.userId, { kind });
  return c.json(rows);
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

  return c.json(created, 201);
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

  return c.json(updated);
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

  const scope = unsafeCourseScope(existing.courseId);
  const rows = await getMessagesForConversation(db, scope, id!);
  // Only the three fields useChat's `messages` seed needs (id/role/parts) --
  // `parts` is returned exactly as stored, which is exactly as the AI SDK
  // produced it: chatHandler persists inboundMessage.parts (the client's
  // own UIMessage part) for user turns and responseMessage.parts (the AI
  // SDK's final UIMessage) for assistant turns, so a stored row's `parts`
  // is already a valid UIMessage `parts` array -- no replay/reconstruction
  // needed here the way chat.ts's SSE-retry path (replayPersistedPart)
  // needs, since that path is rebuilding a *stream*, not seeding a
  // pre-stream initial array.
  return c.json(rows.map((r) => ({ id: r.id, role: r.role, parts: r.parts })));
}

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post/patch/delete("/api/conversations...", ...) in server/index.ts.
export const conversationsRoutes = new Hono<AppEnv>();
conversationsRoutes.get("/", listConversationsHandler);
conversationsRoutes.post("/", createConversationHandler);
conversationsRoutes.get("/:id/messages", listConversationMessagesHandler);
conversationsRoutes.patch("/:id", updateConversationHandler);
conversationsRoutes.delete("/:id", deleteConversationHandler);
