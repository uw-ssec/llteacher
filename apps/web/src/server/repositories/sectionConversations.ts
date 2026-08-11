import { and, eq, isNull } from "drizzle-orm";
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
import { runAtomically } from "./atomic";
import { SubmissionGradedError } from "./submissions";

/* --------------------------------------------------------------------------
   Section-conversation lifecycle (#27), kept in its own module rather than
   added to repositories/conversations.ts.

   conversations.ts is the *tutor* conversation surface (course-scoped free
   chat: list, rename, message history). Section conversations are a different
   resource with different rules -- they are bound to a section, they can be
   submitted, and restarting one has to reason about that submission. Splitting
   them keeps each file about one thing, and it keeps this work off the file
   PR #212 is actively rewriting.
   -------------------------------------------------------------------------- */

/** Django parity greeting, verbatim from ConversationService.
 *  _create_initial_message (apps/conversations/src/conversations/services.py).
 *  Stored as an `assistant` message, matching Django's MESSAGE_TYPE_AI -- the
 *  tutor is speaking to the student, so it is not a `system` message. */
export function sectionGreeting(section: { order: number; title: string; content: string }): string {
  return `Hello! I'm here to help you with Section ${section.order}: ${section.title}.\n\n${section.content}\n\nHow can I assist you with this question?`;
}

/** The message `parts` shape the AI SDK uses, and that messages.parts stores. */
function greetingParts(text: string) {
  return [{ type: "text", text }];
}

export class SectionConversationExistsError extends Error {
  constructor() {
    super("An active conversation already exists for this section");
    this.name = "SectionConversationExistsError";
  }
}

type StartInput = {
  sectionId: string;
  ownerUserId: string;
  /** #27: recorded at creation rather than derived from the owner's role at
   *  read time -- see the column comment on conversations.isTeacherTest. The
   *  route derives this from the caller's course role. */
  isTeacherTest: boolean;
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
): Promise<{ id: string; title: string; greetingMessageId: string }> {
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
    throw new Error("Owner is not a member of this course scope");
  }

  const [section] = await db
    .select({
      id: sections.id,
      order: sections.order,
      title: sections.title,
      content: sections.content,
      type: sections.type,
    })
    .from(sections)
    .innerJoin(homeworks, eq(sections.homeworkId, homeworks.id))
    .where(and(eq(sections.id, input.sectionId), eq(homeworks.courseId, scope)));
  if (!section) {
    throw new Error("Section not found in this course scope");
  }
  // #164: a non_interactive section has no conversation by design -- it
  // collects a single answer instead. Without this, a client could mint a
  // chat against one and the submissions matrix would report a conversation
  // for a section type that is defined never to have any.
  if (section.type === "non_interactive") {
    throw new Error("Section is not interactive and cannot hold a conversation");
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
  const title = `Section ${section.order}: ${section.title}`;

  await runAtomically(db, (t) => [
    t.insert(conversations).values({
      id: conversationId,
      ownerUserId: input.ownerUserId,
      courseId: scope,
      sectionId: input.sectionId,
      kind: "section",
      title,
      isTeacherTest: input.isTeacherTest,
    }),
    t.insert(messages).values({
      id: greetingMessageId,
      conversationId,
      role: "assistant",
      parts: greetingParts(sectionGreeting(section)),
    }),
  ]);

  return { id: conversationId, title, greetingMessageId };
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
    })
    .from(conversations)
    .innerJoin(courses, eq(conversations.courseId, courses.id))
    .innerJoin(sections, eq(conversations.sectionId, sections.id))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(courses.organizationId, scope),
        eq(conversations.isDeleted, false),
        eq(conversations.kind, "section"),
      ),
    );
  if (!owned) {
    throw new Error("Conversation not found or not accessible");
  }
  if (owned.ownerUserId !== requesterId) {
    throw new Error("Conversation is not owned by requester");
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
  const title = `Section ${owned.sectionOrder}: ${owned.sectionTitle}`;

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
 *  in, and the order messages_conversation_created_idx already serves. */
export async function getSectionConversationMessages(db: Db, conversationId: string) {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      parts: messages.parts,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}

/** Who may read a given section conversation (#27 access rules).
 *
 *  Django parity, made explicit:
 *   - the owner always may;
 *   - an instructor of the course may read a *student's* conversation;
 *   - an instructor may NOT read another instructor's test conversation --
 *     someone else's scratch work trying out prompts is not course records.
 *     Their own remains readable, which the owner clause already covers.
 *
 *  Pure function over already-fetched values so the rule is testable on its
 *  own and cannot silently diverge between the read route and the list route. */
export function canReadSectionConversation(
  conversation: { ownerUserId: string; isTeacherTest: boolean },
  viewer: { userId: string; isInstructor: boolean },
): boolean {
  if (conversation.ownerUserId === viewer.userId) return true;
  if (!viewer.isInstructor) return false;
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
