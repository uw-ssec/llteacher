import { and, desc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  conversations,
  messages,
  sections,
  homeworks,
  courses,
  courseMemberships,
  submissions,
  grades,
} from "../../db/schema";
import type { CourseScope, OrgScope } from "./scope";
import { unsafeCourseScope } from "./scope";
import { runAtomically } from "./atomic";
import { SubmissionGradedError } from "./submissions";
import { getOrgScopeForCourse } from "./organizations";
import { deriveHomeworkStatus, isUnreleased } from "./homeworks";
import { resolvePromptTemplate, sectionGreeting, sectionConversationTitle } from "../../lib/prompts";
import { DEFAULT_MESSAGES_PAGE_SIZE } from "./conversations";
import { isUniqueViolation } from "./errors";

/* --------------------------------------------------------------------------
   Section-conversation lifecycle (#27), kept in its own module rather than
   added to repositories/conversations.ts.

   conversations.ts is the *tutor* conversation surface (course-scoped free
   chat: list, rename, message history). Section conversations are a different
   resource with different rules -- they are bound to a section, they can be
   submitted, and restarting one has to reason about that submission. Splitting
   them keeps each file about one thing, and it keeps this work off the file
   PR #212 is actively rewriting.

   #305: sectionGreeting/sectionConversationTitle -- the persona/wording this
   module used to own directly -- now live in lib/prompts.ts, imported above.
   This repository stays about persistence; prompt-facing copy stays in the
   prompt-assembly module.
   -------------------------------------------------------------------------- */

/** The message `parts` shape the AI SDK uses, and that messages.parts stores. */
function greetingParts(text: string) {
  return [{ type: "text", text }];
}

/* --------------------------------------------------------------------------
   Typed errors (#236).

   Every throw below is a class, not a plain Error, so route handlers can
   catch exactly the conditions they know how to translate and let everything
   else propagate to app.onError -- which logs it and returns 503. The first
   draft of these routes ended in a bare `catch { return 404 }`, which meant a
   dropped database connection was reported to the client as a routine
   not-found and never logged.
   -------------------------------------------------------------------------- */

/** Base class so a route can catch "an expected repository refusal" in one
 *  clause without enumerating every subclass, and so an unexpected error is
 *  structurally excluded rather than excluded by a message match. */
export class SectionConversationError extends Error {}

export class SectionConversationExistsError extends SectionConversationError {
  constructor() {
    super("An active conversation already exists for this section");
    this.name = "SectionConversationExistsError";
  }
}

/** The section does not exist in this course, or the caller is not a member.
 *  Deliberately one class for both: the route must not let a caller tell
 *  those apart and use the difference to probe which sections exist. */
export class SectionNotFoundError extends SectionConversationError {
  constructor(message = "Section not found") {
    super(message);
    this.name = "SectionNotFoundError";
  }
}

/** #164: the section exists and is visible to the caller, it just never has a
 *  conversation. Distinct from SectionNotFoundError because reporting it as
 *  "not found" contradicts what the client already has on screen (#241). */
export class SectionNotInteractiveError extends SectionConversationError {
  constructor() {
    super("Section is not interactive and cannot hold a conversation");
    this.name = "SectionNotInteractiveError";
  }
}

/** The conversation is absent, soft-deleted, the wrong kind, or owned by
 *  someone else. Kept as two subclasses so the repository still reports the
 *  distinction (routes choose to collapse it); see the comment in
 *  restartSectionConversation. */
export class ConversationNotFoundError extends SectionConversationError {
  constructor() {
    super("Conversation not found or not accessible");
    this.name = "ConversationNotFoundError";
  }
}

export class NotConversationOwnerError extends SectionConversationError {
  constructor() {
    super("Conversation is not owned by requester");
    this.name = "NotConversationOwnerError";
  }
}

// isUniqueViolation moved to repositories/errors.ts (code-review follow-up:
// promptTemplates.ts needed the identical helper, so a third reimplementation
// was the wrong move).

type StartInput = {
  sectionId: string;
  ownerUserId: string;
  /** #27: recorded at creation rather than derived from the owner's role at
   *  read time -- see the column comment on conversations.isTeacherTest. The
   *  route derives this from the caller's course role. */
  isTeacherTest: boolean;
  /** #317 review, blocking finding #4: distinct from isTeacherTest above --
   *  isTeacherTest is true for any non-student (TA, instructor, observer),
   *  but #172's own capability model means a TA without the canViewDrafts
   *  grant must NOT be able to start a conversation (test or otherwise) on
   *  a section the instructor hasn't released, the same gate every sibling
   *  read path already applies. Callers pass authContext.canViewDraftsIn
   *  (courseId) here -- this function has no authContext of its own to
   *  derive it from. */
  canViewDrafts: boolean;
};

/** Creates a section conversation plus its opening tutor message.
 *
 *  Both rows are written in one atomic group with client-generated UUIDs: the
 *  neon-http driver's batch() cannot feed a RETURNING id from one statement
 *  into the next, and a conversation that exists without its greeting is a
 *  visibly broken chat. Same id-ahead-of-insert technique updateHomework
 *  already uses for sections.
 *
 *  Throws SectionConversationExistsError if the student already has an active
 *  conversation on this section. conversations_owner_section_active_uq would
 *  reject it anyway; this turns that into a 409 the route can explain instead
 *  of a generic constraint failure. */
export async function startSectionConversation(
  db: Db,
  scope: CourseScope,
  input: StartInput,
): Promise<{
  id: string;
  title: string;
  greetingMessageId: string;
  greetingParts: unknown;
  promptTemplateId: string | null;
}> {
  // Membership and section-in-course are both caller-supplied and must be
  // verified before writing -- same rationale as createConversation's checks
  // in conversations.ts. droppedAt IS NULL matches listMembershipsForUser:
  // a dropped membership must not be able to originate new conversations.
  const [membership] = await db
    .select({ id: courseMemberships.id })
    .from(courseMemberships)
    .where(
      and(
        eq(courseMemberships.userId, input.ownerUserId),
        eq(courseMemberships.courseId, scope),
        isNull(courseMemberships.droppedAt),
      ),
    );
  if (!membership) {
    // Same class as a genuinely missing section (#236/#241): a non-member
    // must not learn from the error which sections exist.
    throw new SectionNotFoundError();
  }

  const [section] = await db
    .select({
      id: sections.id,
      order: sections.order,
      title: sections.title,
      content: sections.content,
      type: sections.type,
      dueDate: homeworks.dueDate,
      publishedAt: homeworks.publishedAt,
      releasedAt: homeworks.releasedAt,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(and(eq(sections.id, input.sectionId), eq(homeworks.courseId, scope)));
  if (!section) {
    throw new SectionNotFoundError();
  }
  // #317 review, blocking finding #4: the greeting written below is built
  // from section.content -- an unreleased section's problem statement would
  // leak into it the moment a conversation starts, before chat.ts's own
  // per-turn gate (lib/prompts.ts's getSectionPromptContext) ever runs.
  // Collapses to the same SectionNotFoundError the row-missing case above
  // throws, so this stays indistinguishable from a genuinely missing
  // section (#236/#241's own rationale).
  if (
    !input.canViewDrafts &&
    isUnreleased(
      deriveHomeworkStatus({
        dueDate: section.dueDate,
        publishedAt: section.publishedAt,
        releasedAt: section.releasedAt,
        isHidden: section.isHidden,
        expiresAt: section.expiresAt,
      }),
    )
  ) {
    throw new SectionNotFoundError();
  }
  // #164: a non_interactive section has no conversation by design -- it
  // collects a single answer instead. Without this, a client could mint a
  // chat against one and the submissions matrix would report a conversation
  // for a section type that is defined never to have any.
  if (section.type === "non_interactive") {
    throw new SectionNotInteractiveError();
  }

  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.ownerUserId, input.ownerUserId),
        eq(conversations.sectionId, input.sectionId),
        eq(conversations.isDeleted, false),
      ),
    );
  if (existing) {
    throw new SectionConversationExistsError();
  }

  const conversationId = crypto.randomUUID();
  const greetingMessageId = crypto.randomUUID();
  const title = sectionConversationTitle(section);
  const greeting = greetingParts(sectionGreeting(section));

  // #25: resolved and pinned once, here, at creation -- see lib/prompts.ts's
  // module doc comment for why this must never be re-resolved per-message.
  // Best-effort: a missing org scope (shouldn't happen for a course that
  // just passed every check above) degrades to no pin rather than failing
  // section start entirely over a prompt-template lookup.
  const orgScope = await getOrgScopeForCourse(db, scope);
  const promptTemplateId = orgScope
    ? (await resolvePromptTemplate(db, orgScope, scope, input.sectionId)).id
    : null;

  // #238: the pre-check above is a courtesy, not the guarantee -- it and the
  // insert are separate round-trips, so a double-clicked "Start" can put two
  // requests past it. conversations_owner_section_active_uq is what actually
  // holds; translating its violation here means the racing caller gets the
  // same 409 as the caller that lost the check, instead of a generic 503.
  try {
    await runAtomically(db, (t) => [
      t.insert(conversations).values({
        id: conversationId,
        ownerUserId: input.ownerUserId,
        courseId: scope,
        sectionId: input.sectionId,
        kind: "section",
        title,
        isTeacherTest: input.isTeacherTest,
        promptTemplateId,
      }),
      t.insert(messages).values({
        id: greetingMessageId,
        conversationId,
        role: "assistant",
        parts: greeting,
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, "conversations_owner_section_active_uq")) {
      throw new SectionConversationExistsError();
    }
    throw err;
  }

  // #272: chatHandler needs the greeting's actual content (not just its id)
  // to prepend it to the model's context on the turn that creates it --
  // without this, the tutor answers the student's first message in a
  // section having never seen the greeting (and therefore the section's
  // actual question text, section.content, which the greeting is the sole
  // delivery mechanism for).
  return { id: conversationId, title, greetingMessageId, greetingParts: greeting, promptTemplateId };
}

/** Delete-and-restart, in one action (#27) with #128's voiding semantics.
 *
 *  Soft-deletes the current conversation, voids its submission if it has one,
 *  and creates a replacement conversation with a fresh greeting -- all in a
 *  single atomic group. Partially applied, this would either strand a
 *  submission against an invisible conversation (#128's bug) or leave the
 *  student with no conversation at all on a section they were working.
 *
 *  A graded submission cannot be restarted: throws SubmissionGradedError,
 *  which the route maps to 409. grades.submission_id is ON DELETE RESTRICT, so
 *  Postgres refuses the delete even if this check were removed.
 *
 *  Scoped by OrgScope because voiding a submission is an org-scoped write; the
 *  replacement conversation's courseId is taken from the row this function
 *  already read, rather than adding a second scope parameter that could
 *  disagree with it. */
export async function restartSectionConversation(
  db: Db,
  scope: OrgScope,
  conversationId: string,
  requesterId: string,
  // #317 review, blocking finding #4: same leak vector as
  // startSectionConversation -- a restart writes a fresh greeting from
  // section.content too, so this needs the same gate. Not part of
  // Cordero's own flagged pair (getSectionPromptContext,
  // startSectionConversation), but the identical vulnerability class:
  // fixed alongside them rather than left for a separate pass.
  canViewDrafts: boolean,
): Promise<{
  voidedSubmission: { id: string; submittedAt: Date } | null;
  conversation: { id: string; title: string; greetingMessageId: string };
}> {
  // Same check shape, and the same deliberate two-message split, as
  // submitSection: the repository reports "absent" and "not yours"
  // distinctly so the route can decide which to collapse, rather than having
  // that choice forced on it by a single indistinguishable message.
  const [owned] = await db
    .select({
      id: conversations.id,
      ownerUserId: conversations.ownerUserId,
      courseId: conversations.courseId,
      sectionId: conversations.sectionId,
      isTeacherTest: conversations.isTeacherTest,
      sectionOrder: sections.order,
      sectionTitle: sections.title,
      sectionContent: sections.content,
      dueDate: homeworks.dueDate,
      publishedAt: homeworks.publishedAt,
      releasedAt: homeworks.releasedAt,
      isHidden: homeworks.isHidden,
      expiresAt: homeworks.expiresAt,
    })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(courses.organizationId, scope),
        eq(conversations.isDeleted, false),
        eq(conversations.kind, "section"),
      ),
    );
  if (!owned) {
    throw new ConversationNotFoundError();
  }
  if (owned.ownerUserId !== requesterId) {
    throw new NotConversationOwnerError();
  }
  if (
    !canViewDrafts &&
    isUnreleased(
      deriveHomeworkStatus({
        dueDate: owned.dueDate,
        publishedAt: owned.publishedAt,
        releasedAt: owned.releasedAt,
        isHidden: owned.isHidden,
        expiresAt: owned.expiresAt,
      }),
    )
  ) {
    // Same "absent" bucket ConversationNotFoundError already covers above --
    // a withdrawn section's conversation must not be restartable (which
    // would leak its content into a fresh greeting) any more than it's
    // reachable for a first-ever start.
    throw new ConversationNotFoundError();
  }

  const [submission] = await db
    .select({ id: submissions.id, submittedAt: submissions.submittedAt })
    .from(submissions)
    .where(
      and(eq(submissions.conversationId, conversationId), eq(submissions.organizationId, scope)),
    );

  if (submission) {
    const [grade] = await db
      .select({ id: grades.id })
      .from(grades)
      .where(eq(grades.submissionId, submission.id));
    if (grade) {
      throw new SubmissionGradedError();
    }
  }

  const newConversationId = crypto.randomUUID();
  const greetingMessageId = crypto.randomUUID();
  const title = sectionConversationTitle({ order: owned.sectionOrder, title: owned.sectionTitle });

  // #25: a restart is a fresh conversation lifecycle start (same reasoning
  // as startSectionConversation's own pin) -- re-resolved now rather than
  // carried over from the conversation being replaced, so a template edit
  // made between the original start and this restart is picked up, exactly
  // once, for the replacement's own lifetime.
  const promptTemplateId = (
    await resolvePromptTemplate(db, scope, unsafeCourseScope(owned.courseId), owned.sectionId)
  ).id;

  await runAtomically(db, (t) => [
    // Soft-delete first: conversations_owner_section_active_uq permits only
    // one active conversation per (owner, section), so the insert below is
    // only legal once this row stops being active. Order matters within the
    // group -- both drivers apply statements in sequence.
    t
      .update(conversations)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(conversations.id, conversationId)),
    ...(submission ? [t.delete(submissions).where(eq(submissions.id, submission.id))] : []),
    t.insert(conversations).values({
      id: newConversationId,
      ownerUserId: owned.ownerUserId,
      courseId: owned.courseId,
      sectionId: owned.sectionId,
      kind: "section",
      title,
      // Carried from the conversation being replaced, not re-derived from the
      // requester's current role: restarting a test conversation yields
      // another test conversation, and a since-promoted student's restart
      // does not silently convert their work into a teacher test.
      isTeacherTest: owned.isTeacherTest,
      promptTemplateId,
    }),
    t.insert(messages).values({
      id: greetingMessageId,
      conversationId: newConversationId,
      role: "assistant",
      parts: greetingParts(
        sectionGreeting({
          order: owned.sectionOrder,
          title: owned.sectionTitle,
          content: owned.sectionContent,
        }),
      ),
    }),
  ]);

  return {
    voidedSubmission: submission
      ? { id: submission.id, submittedAt: submission.submittedAt }
      : null,
    conversation: { id: newConversationId, title, greetingMessageId },
  };
}

export type SectionConversationRow = {
  id: string;
  ownerUserId: string;
  courseId: string;
  sectionId: string | null;
  title: string;
  isTeacherTest: boolean;
  isDeleted: boolean;
  createdAt: Date;
  promptTemplateId: string | null;
};

/** One section conversation by id, course-scoped. Returns soft-deleted rows
 *  too -- the caller decides whether a deleted conversation is still
 *  readable (an instructor reviewing what a student restarted away from may
 *  legitimately want it; the student's own live view does not). */
export async function getSectionConversationById(
  db: Db,
  scope: CourseScope,
  conversationId: string,
): Promise<SectionConversationRow | undefined> {
  const [row] = await db
    .select({
      id: conversations.id,
      ownerUserId: conversations.ownerUserId,
      courseId: conversations.courseId,
      sectionId: conversations.sectionId,
      title: conversations.title,
      isTeacherTest: conversations.isTeacherTest,
      isDeleted: conversations.isDeleted,
      createdAt: conversations.createdAt,
      promptTemplateId: conversations.promptTemplateId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.courseId, scope),
        eq(conversations.kind, "section"),
      ),
    );
  return row;
}

/** The caller's own active conversation on a section, if any. */
export async function getActiveSectionConversation(
  db: Db,
  scope: CourseScope,
  sectionId: string,
  ownerUserId: string,
): Promise<SectionConversationRow | undefined> {
  const [row] = await db
    .select({
      id: conversations.id,
      ownerUserId: conversations.ownerUserId,
      courseId: conversations.courseId,
      sectionId: conversations.sectionId,
      title: conversations.title,
      isTeacherTest: conversations.isTeacherTest,
      isDeleted: conversations.isDeleted,
      createdAt: conversations.createdAt,
      promptTemplateId: conversations.promptTemplateId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.courseId, scope),
        eq(conversations.sectionId, sectionId),
        eq(conversations.ownerUserId, ownerUserId),
        eq(conversations.kind, "section"),
        eq(conversations.isDeleted, false),
      ),
    );
  return row;
}

/** Messages for a conversation, oldest first -- the order a transcript reads
 *  in.
 *
 *  #283: ordered by `seq` (a monotonic bigserial), not `createdAt` -- the
 *  same tiebreaker repositories/conversations.ts's getLastMessages/
 *  getMessagesForConversation use (#221), and ARCHITECTURE.md's "Message
 *  Ordering" section claims for "every" messages-in-order query. This
 *  function was the one left behind: `createdAt` is `timestamptz`
 *  (microsecond resolution) and was only safe as a sole ordering key
 *  because each `appendMessage` call was its own separate transaction, so
 *  two rows could never share a timestamp -- a guarantee `seq` makes
 *  independent of that fact. That assumption is no longer even true for
 *  this conversation's own first two rows: startSectionConversation writes
 *  the conversation and its greeting message in one atomic `db.batch`
 *  group, exactly the "batched writes" condition this file's own doc
 *  comment on `seq` names as when `createdAt` stops being safe. `seq` is
 *  included in the projection (not just used for ordering) so a caller can
 *  page consistently via `before` -- exactly the same shape as
 *  getMessagesForConversation's own `before` cursor.
 *
 *  #317 review, #326: was completely unbounded (no `.limit()`, no cursor)
 *  while its tutor-side equivalent (getMessagesForConversation) was already
 *  paginated at DEFAULT_MESSAGES_PAGE_SIZE -- a long-running section
 *  conversation's full transcript, unbounded jsonb `parts` included, on
 *  every reload. Same "fetch the tail descending, reverse to ascending"
 *  shape as getMessagesForConversation, so both message-history endpoints
 *  in this app now share one pagination convention, not two. */
export async function getSectionConversationMessages(
  db: Db,
  conversationId: string,
  opts?: { limit?: number; before?: number },
) {
  const limit = opts?.limit ?? DEFAULT_MESSAGES_PAGE_SIZE;
  const conditions = [eq(messages.conversationId, conversationId)];
  if (opts?.before !== undefined) {
    conditions.push(lt(messages.seq, opts.before));
  }
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      parts: messages.parts,
      createdAt: messages.createdAt,
      seq: messages.seq,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit);
  return rows.reverse();
}

/** Who may read a given section conversation (#27 access rules, widened to
 *  grader tier by #246).
 *
 *  Django parity, made explicit:
 *   - the owner always may;
 *   - a grader of the course (#172's GRADER_ROLES: instructor, admin, ta)
 *     may read a *student's* conversation;
 *   - a grader may NOT read another grader's test conversation -- someone
 *     else's scratch work trying out prompts is not course records. Their
 *     own remains readable, which the owner clause already covers.
 *
 *  #246: originally gated on isInstructorOf (AUTHOR_ROLES: instructor/admin
 *  only), while the submissions dashboard this feeds into is gated on
 *  requireGraderOf (GRADER_ROLES, which also admits ta) -- a TA could see a
 *  submission in the matrix and then 403 opening the transcript behind it.
 *  Widened to consume isGraderOf's result so the two surfaces share one
 *  tier; the checks themselves (ownership, teacher-test exclusion) are
 *  unchanged, only who is entitled to reach them.
 *
 *  Pure function over already-fetched values so the rule is testable on its
 *  own and cannot silently diverge between the read route and the list route. */
export function canReadSectionConversation(
  conversation: { ownerUserId: string; isTeacherTest: boolean },
  viewer: { userId: string; isGrader: boolean },
): boolean {
  if (conversation.ownerUserId === viewer.userId) return true;
  if (!viewer.isGrader) return false;
  return !conversation.isTeacherTest;
}

/** Only the owner may write (send messages, submit, restart). An instructor
 *  reading a student's conversation is a reader, never a participant --
 *  otherwise an instructor could inject turns into a student's transcript and
 *  the submitted record would no longer be the student's own work. */
export function canWriteSectionConversation(
  conversation: { ownerUserId: string },
  viewer: { userId: string },
): boolean {
  return conversation.ownerUserId === viewer.userId;
}

/** True only when the caller's membership in this course is `student`.
 *
 *  #237: deliberately not "not an instructor" -- a `ta` or `observer` role
 *  is neither `student` nor `instructor`/`admin` (the tiers isInstructorOf
 *  checks), and would be misclassified as a student by that shortcut. Roles
 *  other than student are never doing the assignment, so the safe default
 *  for an unrecognized or missing membership is "not a student" -- a
 *  conversation wrongly marked as a teacher test is merely unsubmittable,
 *  whereas one wrongly marked as a student's pollutes real coursework.
 *
 *  #259: shared by both callers that create a section conversation
 *  (routes/sectionConversations.ts's startSectionConversationHandler and
 *  chat.ts's kind:"section" branch) -- previously duplicated once already
 *  and drifted (chat.ts's copy didn't exist at all, defaulting every
 *  section conversation to isTeacherTest: false), which is exactly the
 *  failure mode a single shared implementation forecloses. Takes plain
 *  membership data, not AuthContext, so this repository module doesn't need
 *  to import the auth layer's types. */
export function isStudentInCourse(memberships: { courseId: string; role: string }[], courseId: string): boolean {
  const membership = memberships.find((m) => m.courseId === courseId);
  return membership?.role === "student";
}
