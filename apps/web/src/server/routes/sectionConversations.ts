import { type Context } from "hono";
import { Effect } from "effect";
import { UUID_RE } from "../utils/uuid";
import {
  startSectionConversation,
  restartSectionConversation,
  getSectionConversationById,
  getActiveSectionConversation,
  getSectionConversationMessages,
  canReadSectionConversation,
  isStudentInCourse,
  SectionConversationExistsError,
  SectionNotFoundError,
  SectionNotInteractiveError,
  ConversationNotFoundError,
  NotConversationOwnerError,
} from "../repositories/sectionConversations";
import { getOrgScopeForCourse } from "../repositories/organizations";
import { SubmissionGradedError } from "../repositories/submissions";
import { getSectionPromptContext, SECTION_CONVERSATION_PROMPTS } from "../../lib/prompts";
import type { AppEnv } from "../context";
import { BadRequest, Conflict, Forbidden, NotFound } from "../effect/errors";
import { effectHandler, requireCourseAccess } from "../effect/http";
import { query } from "../effect/services";

// #317 review, #326: same limit/before validation as
// routes/conversations.ts's listConversationMessagesHandler, shared by this
// file's two message-history handlers below (getActiveSectionConversationHandler,
// getSectionConversationHandler) instead of tripling the copy across two
// files.
function parseMessagesPageParams(
  c: Context<AppEnv>,
): Effect.Effect<{ limit?: number; before?: number }, BadRequest> {
  const limitParam = c.req.query("limit");
  let limit: number | undefined;
  if (limitParam !== undefined) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
      return Effect.fail(new BadRequest({ message: "limit must be an integer between 1 and 500" }));
    }
    limit = parsed;
  }
  const beforeParam = c.req.query("before");
  let before: number | undefined;
  if (beforeParam !== undefined) {
    const parsed = Number(beforeParam);
    if (!Number.isInteger(parsed)) {
      return Effect.fail(new BadRequest({ message: "before must be an integer seq value" }));
    }
    before = parsed;
  }
  return Effect.succeed({ limit, before });
}

/* --------------------------------------------------------------------------
   Section-conversation routes (#27).

   Separate from routes/conversations.ts (tutor conversations, PR #212) --
   different resource, different access rules, and keeping them apart avoids
   two branches rewriting one file.
   -------------------------------------------------------------------------- */

/** Shared shape for "the id in the path isn't even a UUID". Returns the same
 *  body a genuine miss returns, so shape is never an existence oracle --
 *  the SEC-020/#211 rule, applied here from the start rather than retrofitted. */
const conversationNotFound = () => new NotFound({ message: "Conversation not found" });

type MessageRow = { id: string; role: string; parts: unknown; createdAt: Date };

function toMessageResponse(m: MessageRow) {
  return { id: m.id, role: m.role, parts: m.parts, createdAt: m.createdAt.toISOString() };
}

export const startSectionConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const { authContext, courseId, scope } = yield* requireCourseAccess(c);
  const sectionId = c.req.param("sectionId");
  if (!sectionId || !UUID_RE.test(sectionId)) {
    return yield* new NotFound({ message: "Section not found" });
  }

  const created = yield* query(
    "startSectionConversation",
    (db) => startSectionConversation(db, scope, {
      sectionId,
      ownerUserId: authContext.session.userId,
      // #27/#237: anyone who is not a student working this section is
      // testing it, not doing it. Derived from the caller's actual course
      // role rather than isInstructorOf, whose AUTHOR_ROLES tier is
      // instructor+admin only -- a TA or observer would otherwise be
      // recorded as a student and their conversation would be submittable.
      // Recorded now rather than derived later; see the isTeacherTest
      // column comment for why storing beats deriving.
      isTeacherTest: !isStudentInCourse(authContext.memberships, courseId),
      canViewDrafts: authContext.canViewDraftsIn(courseId),
      // #305: the greeting/title wording is this route's choice to make, not
      // the repository's -- see SECTION_CONVERSATION_PROMPTS in lib/prompts.ts.
      prompts: SECTION_CONVERSATION_PROMPTS,
    }),
    [SectionConversationExistsError, SectionNotInteractiveError, SectionNotFoundError],
  ).pipe(Effect.catchTags({
    // 409, not 400: the request is well-formed and the caller is allowed,
    // the resource just already exists. The client's move is to GET it.
    SectionConversationExistsError: (err) => Effect.fail(new Conflict({ message: err.message })),
    // #241: the section exists and the caller can see it -- it just never
    // holds a conversation. Reporting that as 404 contradicts the homework
    // detail response the client already rendered.
    SectionNotInteractiveError: (err) => Effect.fail(new Conflict({ message: err.message })),
    // Non-member owner and section-outside-course collapse to one 404, so a
    // caller can't probe which sections exist in courses they can see.
    SectionNotFoundError: (err) => Effect.fail(new NotFound({ message: err.message })),
  }));
  // #236: anything else is a DatabaseError (effect/services.ts's query), not
  // a refusal this route knows how to translate -- answered 503 and logged,
  // never laundered into a routine not-found.
  return c.json(created, 201);
}));

export const getActiveSectionConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const { authContext, courseId, scope } = yield* requireCourseAccess(c);
  const sectionId = c.req.param("sectionId");
  if (!sectionId || !UUID_RE.test(sectionId)) {
    return yield* new NotFound({ message: "Section not found" });
  }

  const conversation = yield* query(
    "getActiveSectionConversation",
    (db) => getActiveSectionConversation(db, scope, sectionId, authContext.session.userId),
  );
  // Not an error: "you have not started this section yet" is an ordinary
  // state the client renders as a start affordance.
  if (!conversation) return c.json({ conversation: null, messages: [] });

  // #317 review, #351 (requirement 1): the write/model paths (chat.ts,
  // startSectionConversation, restartSectionConversation) all gate on the
  // homework's release state; this read path -- returning `messages`,
  // whose first row is sectionGreeting(section), the full problem statement
  // verbatim -- did not. After an instructor withdraws a homework, POST
  // /api/chat and restart correctly 404; this endpoint kept returning 200
  // with the withdrawn section's content. getSectionPromptContext (already
  // used by chat.ts for the same gate) runs the section->homework join
  // purely for its isUnreleased field here -- the conversation 404, not a
  // distinct body, preserving the no-existence-oracle convention this file
  // already states for getSectionConversationHandler below.
  const sectionContext = yield* query(
    "getSectionPromptContext",
    (db) => getSectionPromptContext(db, scope, sectionId),
  );
  if (sectionContext?.isUnreleased && !authContext.canViewDraftsIn(courseId)) {
    return yield* conversationNotFound();
  }

  const pageParams = yield* parseMessagesPageParams(c);
  const messages = yield* query(
    "getSectionConversationMessages",
    (db) => getSectionConversationMessages(db, conversation.id, pageParams),
  );
  return c.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      sectionId: conversation.sectionId,
      isTeacherTest: conversation.isTeacherTest,
      createdAt: conversation.createdAt.toISOString(),
    },
    messages: messages.map(toMessageResponse),
  });
}));

export const getSectionConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const { authContext, courseId, scope } = yield* requireCourseAccess(c);
  const conversationId = c.req.param("conversationId");
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return yield* conversationNotFound();
  }

  const conversation = yield* query(
    "getSectionConversationById",
    (db) => getSectionConversationById(db, scope, conversationId),
  );
  if (!conversation) return yield* conversationNotFound();

  const allowed = canReadSectionConversation(conversation, {
    userId: authContext.session.userId,
    // #246: grader-tier read (instructor/admin/ta), matching the tier the
    // submissions dashboard that links here already uses (requireGraderOf).
    isGrader: authContext.isGraderOf(courseId),
  });
  // 404 rather than 403: an instructor's private test conversation should not
  // confirm its own existence to another instructor, and a student probing
  // ids should learn nothing from the status code.
  if (!allowed) return yield* conversationNotFound();

  // #317 review, #351 (requirement 1): same gate as
  // getActiveSectionConversationHandler above -- see that call site's own
  // doc comment. `conversation.sectionId` is nullable at the schema level
  // (shared with tutor conversations), but every row this route's own query
  // can return is section-kind, so it's always set in practice; guarded
  // rather than asserted so a future schema/data surprise degrades to
  // "content visible" (today's status quo) rather than a crash.
  const sectionId = conversation.sectionId;
  if (sectionId) {
    const sectionContext = yield* query(
      "getSectionPromptContext",
      (db) => getSectionPromptContext(db, scope, sectionId),
    );
    if (sectionContext?.isUnreleased && !authContext.canViewDraftsIn(courseId)) {
      return yield* conversationNotFound();
    }
  }

  const pageParams = yield* parseMessagesPageParams(c);
  const messages = yield* query(
    "getSectionConversationMessages",
    (db) => getSectionConversationMessages(db, conversation.id, pageParams),
  );
  return c.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      sectionId: conversation.sectionId,
      ownerUserId: conversation.ownerUserId,
      isTeacherTest: conversation.isTeacherTest,
      isDeleted: conversation.isDeleted,
      createdAt: conversation.createdAt.toISOString(),
    },
    messages: messages.map(toMessageResponse),
  });
}));

export const restartSectionConversationHandler = effectHandler((c) => Effect.gen(function* () {
  const { authContext, courseId } = yield* requireCourseAccess(c);
  const conversationId = c.req.param("conversationId");
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return yield* conversationNotFound();
  }

  // Restarting voids a submission, which is an org-scoped write. #239: the
  // org comes from the course named in the path, not from the caller's
  // membership list -- a course belongs to exactly one org, whereas
  // getOrgScopesForUser(...)[0] picks an arbitrary one and silently 404s a
  // legitimate restart for anyone who belongs to more than one.
  const orgScope = yield* query("getOrgScopeForCourse", (db) => getOrgScopeForCourse(db, courseId));
  if (!orgScope) return yield* new Forbidden({ message: "Course access denied" });

  const result = yield* query(
    "restartSectionConversation",
    (db) => restartSectionConversation(
      db,
      orgScope,
      conversationId,
      authContext.session.userId,
      authContext.canViewDraftsIn(courseId),
      // #305: see startSectionConversationHandler above -- a restart's fresh
      // greeting/title comes from the same caller-chosen wording.
      SECTION_CONVERSATION_PROMPTS,
    ),
    [SubmissionGradedError, ConversationNotFoundError, NotConversationOwnerError],
  ).pipe(Effect.catchTags({
    // 409: the caller owns it and the request is well-formed; the section
    // has simply moved past the point where starting over is allowed.
    // Distinguishable from the 404s below because it tells the student
    // something actionable about their own work.
    SubmissionGradedError: (err) => Effect.fail(new Conflict({ message: err.message })),
    // "not found or not accessible" and "not owned by requester" collapse to
    // one 404 -- the same reasoning submitSectionHandler documents: a
    // non-owner must not be able to tell the two apart and learn that a
    // conversation exists.
    ConversationNotFoundError: () => Effect.fail(conversationNotFound()),
    NotConversationOwnerError: () => Effect.fail(conversationNotFound()),
  }));
  return c.json(
    {
      conversation: result.conversation,
      voidedSubmission: result.voidedSubmission
        ? {
            id: result.voidedSubmission.id,
            submittedAt: result.voidedSubmission.submittedAt.toISOString(),
          }
        : null,
    },
    201,
  );
}));
