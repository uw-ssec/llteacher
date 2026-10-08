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
   effect/http.ts's errorResponse (#141) -- a single app-layer mapping
   point, not a per-route catch here.
   -------------------------------------------------------------------------- */

import { Hono, type Context } from "hono";
import { Effect } from "effect";
import { z } from "zod";
import { UUID_RE } from "../utils/uuid";
import {
  listConversationsForOwner,
  createConversation,
  countActiveConversationsForOwner,
  updateConversationTitle,
  softDeleteConversation,
  getOwnedConversationOrNull,
  getMessagesForConversation,
  getConversationMessageCount,
  ConversationHasSubmissionError,
  DEFAULT_CONVERSATIONS_PAGE_SIZE,
} from "../repositories/conversations";
import { TenancyMismatchError } from "../repositories/errors";
import type { ConversationKind } from "../../db/schema";
import { courseScopeFromAuthContext, unsafeCourseScope } from "../repositories/scope";
import { reserveRateLimitSlot, RATE_LIMIT_MAX_PER_MINUTE, RATE_LIMIT_WINDOW_MS } from "../repositories/rateLimits";
// #287: the canonical "untouched default title" sentinel, shared with
// chat.ts's (effectively dead, see its own doc comment) auto-title branch
// and App.tsx's client-side auto-title-on-first-message fix -- so every
// caller that needs to create a title-less row, or decide whether a row is
// still safe to auto-title, agrees on exactly one string.
import { DEFAULT_TUTOR_CONVERSATION_TITLE, MAX_CONVERSATION_TITLE_UTF16_LENGTH } from "../../shared/tutorConversationTitle";
import type { AppEnv } from "../context";
import type {
  ConversationSummary,
  ConversationListItemResponse,
  ConversationListResponse,
  ConversationMessageResponse,
} from "../../shared/types";
import { BadRequest, Conflict, Forbidden, NotFound } from "../effect/errors";
import { effectHandler, requireAuthContext } from "../effect/http";
import { query } from "../effect/services";

// #281: an opaque cursor -- the client only ever echoes this back as
// `before`, never parses or reconstructs it. Encoding (updatedAt, id)
// together server-side is what fixes the precision-loss half of #281: the
// wire value carries the exact Date the server compared against, not a
// client-truncated re-derivation of one, and pairing it with `id` is what
// makes the comparison in listConversationsForOwner a real tiebreaker
// instead of a plain (lossy) timestamp comparison.
function encodeConversationsCursor(cursor: { updatedAt: Date; id: string }): string {
  return btoa(JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), id: cursor.id }));
}
function decodeConversationsCursor(raw: string): { updatedAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(atob(raw)) as { updatedAt?: unknown; id?: unknown };
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") return null;
    const updatedAt = new Date(parsed.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

// #308: no cap existed on how many tutor conversations one authenticated
// student could mint -- unbounded row creation. 300 is generous relative to
// any real usage pattern (the tutor rail is a course-wide scratch space, not
// a per-section resource with a natural cap) while still bounding abuse; a
// student who wants more room can delete old conversations (the count below
// only ever counts live rows).
const MAX_TUTOR_CONVERSATIONS_PER_COURSE = 300;

const createConversationSchema = z.object({
  courseId: z.string().uuid(),
  // #453: shared with deriveTutorConversationTitle's own UTF-16 ceiling
  // (tutorConversationTitle.ts) -- see that constant's own doc comment for
  // why a literal `100` here, independent of that one, is exactly the kind
  // of duplicated-limit drift that let an emoji-heavy auto-title 400
  // silently against this schema in the first place.
  title: z.string().trim().min(1).max(MAX_CONVERSATION_TITLE_UTF16_LENGTH).optional(),
});

const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(MAX_CONVERSATION_TITLE_UTF16_LENGTH),
});

// #218: projects a raw `conversations` row to the wire contract -- drops
// ownerUserId/courseId/sectionId/isDeleted/deletedAt, none of which any
// client reads (see ConversationSummary's doc comment, shared/types.ts).
function toConversationSummary(row: {
  id: string;
  kind: ConversationKind;
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

/** Shared shape for every "not found or not owned" answer in this file --
 *  one body whether the id is malformed, unknown, someone else's, or
 *  soft-deleted, so the response is never an existence oracle. */
const conversationNotFound = () => new NotFound({ message: "Conversation not found" });

/** A body that isn't JSON at all is a client error, not an outage. */
function readJsonBody(c: Context<AppEnv>): Effect.Effect<unknown, BadRequest> {
  return Effect.tryPromise({
    try: () => c.req.json<unknown>(),
    catch: () => new BadRequest({ message: "Request body must be valid JSON" }),
  });
}

export const listConversationsHandler = effectHandler((c) => Effect.gen(function* () {
  // authMiddleware/rolesMiddleware already gate every /api/* route (this
  // route is wired in unguarded via app.get("/api/conversations", ...) in
  // server/index.ts, same as chat.ts) -- re-checked here so a direct call to
  // this handler (as the unit tests below do) fails closed with a 401
  // instead of throwing on authContext.session below.
  const authContext = yield* requireAuthContext(c);

  const courseId = c.req.query("courseId");
  if (!courseId) {
    return yield* new BadRequest({ message: "courseId is required" });
  }

  // Defaults to "tutor": this route's own doc comment above and the client
  // this backs (#27's list surface) only ever ask for tutor conversations
  // today, but the enum genuinely has a second value ("section"), so this
  // is a real filter, not a no-op -- validated against both known values
  // rather than passed through unchecked to the repository's `eq`.
  const kind = c.req.query("kind") ?? "tutor";
  if (kind !== "tutor" && kind !== "section") {
    return yield* new BadRequest({ message: "kind must be 'tutor' or 'section'" });
  }

  // #224: optional pagination. `limit` clamped to a sane range rather than
  // trusted verbatim -- a client-supplied 1000000 would defeat the point of
  // bounding the page. Always resolved to a real number (never left
  // undefined) so this handler knows exactly what page size was requested
  // when it decides below whether a full page came back -- the signal
  // #281's nextCursor is based on.
  const limitParam = c.req.query("limit");
  let limit = DEFAULT_CONVERSATIONS_PAGE_SIZE;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      return yield* new BadRequest({ message: "limit must be an integer between 1 and 200" });
    }
    limit = parsed;
  }
  // #281: `before` is the opaque cursor this same handler emitted as
  // `nextCursor` on a prior page (encodeConversationsCursor/
  // decodeConversationsCursor above) -- the client only ever echoes it
  // back, never constructs or parses one itself.
  const beforeParam = c.req.query("before");
  let before: { updatedAt: Date; id: string } | undefined;
  if (beforeParam !== undefined) {
    const decoded = decodeConversationsCursor(beforeParam);
    if (!decoded) {
      return yield* new BadRequest({ message: "before must be a valid cursor from a prior response's nextCursor" });
    }
    before = decoded;
  }

  // The only sanctioned way to mint a CourseScope from request input (see
  // scope.ts's courseScopeFromAuthContext docstring) -- verifies the caller
  // is actually a member of courseId before this can proceed.
  const scope = courseScopeFromAuthContext(authContext, courseId);
  if (!scope) {
    return yield* new Forbidden({ message: "Course access denied" });
  }

  const rows = yield* query(
    "listConversationsForOwner",
    (db) => listConversationsForOwner(db, scope, authContext.session.userId, { kind, limit, before }),
  );
  const items: ConversationListItemResponse[] = rows.map((r) => ({
    ...toConversationSummary(r),
    messageCount: r.messageCount,
  }));
  // #281: an explicit nextCursor in the response, not something the client
  // reconstructs from the last row (which is exactly how the precision-loss
  // half of this bug happened -- toISOString() truncating a microsecond
  // timestamptz to milliseconds). A full page (rows.length === limit) is
  // the only signal available that more rows might exist; a short page
  // means this was the last one.
  const lastRow = rows[rows.length - 1];
  const nextCursor =
    rows.length === limit && lastRow ? encodeConversationsCursor({ updatedAt: lastRow.updatedAt, id: lastRow.id }) : null;
  const body: ConversationListResponse = { items, nextCursor };
  return c.json(body);
}));

export const createConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = yield* requireAuthContext(c);

  const json = yield* readJsonBody(c);
  // safeParse + a hand-written message (not the raw zod issue) -- matches
  // chat.ts's inboundUserMessageSchema convention rather than surfacing zod's
  // internal error shape to the client.
  const parsed = createConversationSchema.safeParse(json);
  if (!parsed.success) {
    return yield* new BadRequest({ message: "courseId (uuid) is required; title, if present, must be 1-100 chars" });
  }

  const scope = courseScopeFromAuthContext(authContext, parsed.data.courseId);
  if (!scope) {
    return yield* new Forbidden({ message: "Course access denied" });
  }

  // #308: this route had no rate limit at all -- only /api/chat did (#219).
  // Reuses the exact same per-user counter/budget rather than standing up a
  // second one: conversation creation is a rare, deliberate action (the
  // "New conversation" button) next to chat's per-message volume, so
  // sharing one generous per-minute budget between the two costs a normal
  // user nothing while still bounding a scripted create-loop.
  const requestCount = yield* query(
    "reserveRateLimitSlot",
    (db) => reserveRateLimitSlot(db, authContext.session.userId, new Date(), RATE_LIMIT_WINDOW_MS),
  );
  // 429 (and its Retry-After header) has no HttpError outcome, so it stays a
  // directly-built response -- a successful answer of "not now", not a failure.
  if (requestCount > RATE_LIMIT_MAX_PER_MINUTE) {
    return c.json(
      { error: "You're sending requests too quickly. Please wait a moment and try again." },
      429,
      { "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)) },
    );
  }

  // #308: unbounded row creation otherwise -- see MAX_TUTOR_CONVERSATIONS_PER_COURSE's
  // doc comment above.
  const activeCount = yield* query(
    "countActiveConversationsForOwner",
    (db) => countActiveConversationsForOwner(db, scope, authContext.session.userId, "tutor"),
  );
  if (activeCount >= MAX_TUTOR_CONVERSATIONS_PER_COURSE) {
    return c.json(
      {
        error: `You've reached the limit of ${MAX_TUTOR_CONVERSATIONS_PER_COURSE} tutor conversations for this course. Delete an old one to make room.`,
      },
      429,
    );
  }

  // createConversation (repositories/conversations.ts, #3) re-verifies
  // course membership itself (courseScopeFromAuthContext already did, but
  // the repository doesn't trust callers to have checked) and throws a
  // typed TenancyMismatchError on a mismatch -- left untranslated here:
  // effect/http.ts's errorResponse maps it to a 404 (#141), not the generic
  // 503 a DatabaseError gets. Same call shape as chatHandler's
  // new-conversation branch (routes/chat.ts).
  const created = yield* query(
    "createConversation",
    (db) => createConversation(db, scope, {
      ownerUserId: authContext.session.userId,
      sectionId: null,
      kind: "tutor",
      title: parsed.data.title || DEFAULT_TUTOR_CONVERSATION_TITLE,
    }),
    [TenancyMismatchError],
  );

  return c.json(toConversationSummary(created), 201);
}));

// #438: GET /api/conversations/:id -- returns this ONE conversation's
// current summary + messageCount. This is the reconciliation read
// trackTutorTurnCompletion's caller (App.tsx) triggers once a tutor chat
// turn's stream has fully settled: the client cannot tell, from the stream
// alone, whether chat.ts's onFinish persisted one row (the student's
// message only) or two (plus a reply) for that turn, so instead of
// guessing a delta it asks this route for the real count
// (useTutorConversations.ts's reconcileConversationCount). Same ownership
// pattern as PATCH/DELETE/GET-messages below (getOwnedConversationOrNull ->
// 404, never 403, on "doesn't exist or isn't yours").
export const getConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = yield* requireAuthContext(c);

  const id = c.req.param("id");
  // #267: same reasoning as updateConversationHandler's guard below.
  if (!id || !UUID_RE.test(id)) {
    return yield* conversationNotFound();
  }

  const existing = yield* query(
    "getOwnedConversationOrNull",
    (db) => getOwnedConversationOrNull(db, id, authContext.session.userId, authContext.isMemberOf),
  );
  if (!existing) {
    return yield* conversationNotFound();
  }

  // Row just read back and ownership-checked -- the sanctioned case for
  // this cast per scope.ts's unsafeCourseScope docstring (same pattern as
  // updateConversationHandler below).
  const scope = unsafeCourseScope(existing.courseId);
  const messageCount = yield* query(
    "getConversationMessageCount",
    (db) => getConversationMessageCount(db, scope, id),
  );
  const body: ConversationListItemResponse = { ...toConversationSummary(existing), messageCount };
  return c.json(body);
}));

export const updateConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = yield* requireAuthContext(c);

  const id = c.req.param("id");
  // #267: a malformed id would otherwise reach getOwnedConversationOrNull's
  // eq(conversations.id, id) unvalidated, raising Postgres's own "invalid
  // input syntax for type uuid" -- a permanent client error the generic
  // error handler turns into a 503 "try again later" plus a logged server
  // error. 404 instead, matching the existing "not found or not owned"
  // response so a malformed id and an unknown-but-valid one stay
  // indistinguishable (same reasoning as the 404-not-403 convention below).
  if (!id || !UUID_RE.test(id)) {
    return yield* conversationNotFound();
  }
  const json = yield* readJsonBody(c);
  const parsed = updateConversationSchema.safeParse(json);
  if (!parsed.success) {
    return yield* new BadRequest({ message: "title is required and must be 1-100 chars after trimming" });
  }

  const existing = yield* query(
    "getOwnedConversationOrNull",
    (db) => getOwnedConversationOrNull(db, id, authContext.session.userId, authContext.isMemberOf),
  );
  if (!existing) {
    return yield* conversationNotFound();
  }

  // Row just read back and ownership-checked -- the sanctioned case for
  // this cast per scope.ts's unsafeCourseScope docstring.
  const scope = unsafeCourseScope(existing.courseId);
  const updated = yield* query(
    "updateConversationTitle",
    (db) => updateConversationTitle(db, scope, id, parsed.data.title),
  );
  // updateConversationTitle also excludes soft-deleted rows -- a
  // conversation deleted between the check above and this write (or one
  // that was already soft-deleted) 404s here too, same bucket as "not
  // found".
  if (!updated) {
    return yield* conversationNotFound();
  }

  return c.json(toConversationSummary(updated));
}));

export const deleteConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = yield* requireAuthContext(c);

  const id = c.req.param("id");
  // #267: same reasoning as updateConversationHandler's guard above.
  if (!id || !UUID_RE.test(id)) {
    return yield* conversationNotFound();
  }

  const existing = yield* query(
    "getOwnedConversationOrNull",
    (db) => getOwnedConversationOrNull(db, id, authContext.session.userId, authContext.isMemberOf),
  );
  if (!existing) {
    return yield* conversationNotFound();
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
  yield* query(
    "softDeleteConversation",
    (db) => softDeleteConversation(db, scope, id),
    [ConversationHasSubmissionError],
  ).pipe(Effect.catchTags({
    // #128: the caller owns it (this route resolves section conversations
    // too, not only tutor ones) but it has been submitted -- deleting it
    // would orphan the submission. 409: well-formed and allowed, the
    // resource's state refuses it. Previously an untyped throw -> 503.
    ConversationHasSubmissionError: () =>
      Effect.fail(new Conflict({ message: "This conversation has been submitted and cannot be deleted." })),
  }));

  return c.body(null, 204);
}));

// #4: GET /api/conversations/:id/messages -- the only way a client that
// selects an *existing* conversation can reseed its chat, and that is not
// merely a display concern: chatHandler (chat.ts) builds the model's context
// from convertToModelMessages(uiMessages), the array the CLIENT sends, so a
// client-side history that starts empty means the LLM itself has lost every
// prior turn, not just the UI. Any surface that switches into an existing
// conversation must hydrate through this route first. Same ownership pattern
// as PATCH/DELETE above (getOwnedConversationOrNull -> 404, never 403, on
// "doesn't exist or isn't yours") rather than a new one.
export const listConversationMessagesHandler = effectHandler((c) => Effect.gen(function* () {
  const authContext = yield* requireAuthContext(c);

  const id = c.req.param("id");
  // #267: same reasoning as updateConversationHandler's guard above.
  if (!id || !UUID_RE.test(id)) {
    return yield* conversationNotFound();
  }

  const existing = yield* query(
    "getOwnedConversationOrNull",
    (db) => getOwnedConversationOrNull(db, id, authContext.session.userId, authContext.isMemberOf),
  );
  if (!existing) {
    return yield* conversationNotFound();
  }

  // #215: bounded page (limit/before -- a seq cursor), not the entire
  // conversation. Same clamp shape as the list route's `limit` above.
  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return yield* new BadRequest({ message: "limit must be an integer between 1 and 500" });
    }
    limit = parsed;
  }
  const beforeParam = c.req.query("before");
  let before: number | undefined;
  if (beforeParam !== undefined) {
    const parsed = Number(beforeParam);
    if (!Number.isInteger(parsed)) {
      return yield* new BadRequest({ message: "before must be an integer seq value" });
    }
    before = parsed;
  }

  const scope = unsafeCourseScope(existing.courseId);
  const rows = yield* query(
    "getMessagesForConversation",
    (db) => getMessagesForConversation(db, scope, id, { limit, before }),
  );
  // #226: the shape is checked against ConversationMessageResponse now
  // (previously an untyped literal the client asserted a different type
  // over -- neither side of the wire boundary actually enforced it). `parts`
  // stays `unknown`, matching how it's stored (jsonb) and how chat.ts's own
  // replayPersistedPart already treats a persisted row's parts at this same
  // boundary.
  // #280: seq included so a caller can construct the next `before` (this
  // same query's own cursor param) without a second round-trip.
  /* #397: createdAt was selected by the repository (bare .select()) but
     dropped here, so the transcript had no way to show a per-turn time
     without a second round-trip. The sibling section-conversation routes
     already forwarded it; this one was the outlier. */
  const body: ConversationMessageResponse[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    parts: r.parts,
    seq: r.seq,
    createdAt: r.createdAt.toISOString(),
  }));
  return c.json(body);
}));

// Sub-app preserved for direct unit testing; production routing happens via
// app.get/post/patch/delete("/api/conversations...", ...) in server/index.ts.
export const conversationsRoutes = new Hono<AppEnv>();
conversationsRoutes.get("/", listConversationsHandler);
conversationsRoutes.post("/", createConversationHandler);
conversationsRoutes.get("/:id/messages", listConversationMessagesHandler);
conversationsRoutes.get("/:id", getConversationHandler);
conversationsRoutes.patch("/:id", updateConversationHandler);
conversationsRoutes.delete("/:id", deleteConversationHandler);
