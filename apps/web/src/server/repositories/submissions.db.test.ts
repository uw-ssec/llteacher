/* --------------------------------------------------------------------------
   #128 reproduction, against a real Postgres.

   M2 shipped UNIQUE(submissions.conversation_id) and a partial unique index
   allowing one *active* conversation per (student, section). Neither bounds
   submissions per (student, section) across time: submit A, soft-delete A,
   create B for the same section, submit B -- two rows for one section.

   This has to be a real-DB suite. The thing under test is a database
   constraint; a mocked db cannot evaluate a unique index or a composite
   foreign key, so a mock here would pass whether or not the fix exists.

   Skipped without DATABASE_URL, matching every other real-DB suite in this
   repo. CI provides one.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import { unsafeOrgScope } from "./scope";
import { createSubmission } from "./submissions";
import { restartSectionConversation } from "./sectionConversations";
import { SECTION_CONVERSATION_PROMPTS } from "../../lib/prompts";
import {
  organizations,
  courses,
  users,
  courseMemberships,
  homeworks,
  sections,
  conversations,
  submissions,
} from "../../db/schema";

const RAW_DATABASE_URL = process.env.DATABASE_URL;

/** The encrypted-column types are branded Uint8Arrays (db/types/encrypted.ts).
 *  These fixtures never decrypt anything, so random bytes of the right shape
 *  are enough -- the cast is confined to this helper rather than sprinkled
 *  through the inserts. */
function randomBytes(): never {
  return crypto.getRandomValues(new Uint8Array(16)) as never;
}

describe.skipIf(!RAW_DATABASE_URL)("submissions uniqueness (real DB, #128)", () => {
  let db: Db;
  let orgId: string;
  let courseId: string;
  let sectionId: string;
  let userId: string;

  beforeAll(async () => {
    db = makeNodeDb(RAW_DATABASE_URL!);

    const [org] = await db
      .insert(organizations)
      .values({
        name: "128-org",
        slug: `s128-${crypto.randomUUID().slice(0, 8)}`,
        workosOrganizationId: `org_${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning({ id: organizations.id });
    orgId = org!.id;

    const [course] = await db
      .insert(courses)
      .values({
        organizationId: orgId,
        code: `C-${crypto.randomUUID().slice(0, 8)}`,
        term: "T",
        title: "t",
      })
      .returning({ id: courses.id });
    courseId = course!.id;

    const [user] = await db
      .insert(users)
      .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
      .returning({ id: users.id });
    userId = user!.id;

    await db.insert(courseMemberships).values({ userId, courseId, role: "student" });

    // homeworks.created_by_id is an FK to course_memberships, not users, so
    // the author needs a membership row of its own. Made an instructor
    // rather than reusing the student's membership -- a student-authored
    // homework would be a fixture that misrepresents the domain.
    const [instructor] = await db
      .insert(users)
      .values({ email: randomBytes(), emailBlindIndex: randomBytes() })
      .returning({ id: users.id });
    const [instructorMembership] = await db
      .insert(courseMemberships)
      .values({ userId: instructor!.id, courseId, role: "instructor" })
      .returning({ id: courseMemberships.id });

    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId,
        createdById: instructorMembership!.id,
        title: "hw",
        description: "d",
        dueDate: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: homeworks.id });

    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw!.id, title: "s", content: "c", order: 1 })
      .returning({ id: sections.id });
    sectionId = section!.id;
  });

  afterAll(async () => {
    // One delete: every fixture above hangs off the org by a cascading FK.
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  async function makeSectionConversation() {
    const [c] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId, kind: "section", title: "c" })
      .returning({ id: conversations.id });
    return c!.id;
  }

  /** Each test starts from a clean slate for this student, so a leftover row
   *  from an earlier test can't be what makes a uniqueness assertion pass --
   *  or, in the other direction, what makes a fixture insert fail.
   *  Conversations are deleted rather than just submissions: an *active*
   *  section conversation left behind by an earlier test collides with
   *  conversations_owner_section_active_uq the next time one is created.
   *  Submissions cascade from conversations, so this covers both. */
  async function resetStudentState() {
    await db.delete(conversations).where(eq(conversations.ownerUserId, userId));
  }

  it("refuses a second submission for the same (student, section) after delete-and-recreate", async () => {
    await resetStudentState();
    const scope = unsafeOrgScope(orgId);

    const convA = await makeSectionConversation();
    await createSubmission(db, scope, convA);

    // Soft-delete A. This is what frees conversations_owner_section_active_uq
    // and lets B exist -- and is exactly what #27's delete-and-restart does.
    await db
      .update(conversations)
      .set({ isDeleted: true, deletedAt: new Date() })
      .where(eq(conversations.id, convA));

    const convB = await makeSectionConversation();

    // Before this change: resolves, leaving two rows for one section.
    await expect(createSubmission(db, scope, convB)).rejects.toThrow();

    const rows = await db.select().from(submissions).where(eq(submissions.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("rejects a submission whose denormalized pair disagrees with its conversation", async () => {
    await resetStudentState();
    const conv = await makeSectionConversation();

    // Hand-written insert bypassing createSubmission entirely: the composite
    // FK, not application code, is what has to reject this. If this only
    // passed because createSubmission copies the right values, the columns
    // would still be free to drift from any other writer.
    await expect(
      db.insert(submissions).values({
        conversationId: conv,
        organizationId: orgId,
        userId,
        sectionId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("rejects a submission against a tutor conversation", async () => {
    await resetStudentState();
    const [tutor] = await db
      .insert(conversations)
      .values({ ownerUserId: userId, courseId, sectionId: null, kind: "tutor", title: "t" })
      .returning({ id: conversations.id });

    // section_id is NOT NULL here and NULL on a tutor conversation, so the
    // composite FK can never match -- the kind='section' check in
    // createSubmission is now a friendly error rather than the only thing
    // standing between a tutor chat and a submission row.
    await expect(
      db.insert(submissions).values({
        conversationId: tutor!.id,
        organizationId: orgId,
        userId,
        sectionId,
      }),
    ).rejects.toThrow();
  });

  it("restart voids the submission, freeing the section for a fresh submit", async () => {
    await resetStudentState();
    const scope = unsafeOrgScope(orgId);

    const convA = await makeSectionConversation();
    await createSubmission(db, scope, convA);

    const { voidedSubmission, conversation } = await restartSectionConversation(
      db,
      scope,
      convA,
      userId,
      true,
      SECTION_CONVERSATION_PROMPTS,
    );
    expect(voidedSubmission).not.toBeNull();

    // #27: restart creates the replacement itself, in the same atomic group.
    // The old conversation is soft-deleted, which is what frees
    // conversations_owner_section_active_uq for the new one.
    const [old] = await db.select().from(conversations).where(eq(conversations.id, convA));
    expect(old!.isDeleted).toBe(true);

    // The point of voiding: the section is submittable again, which the
    // unique index would otherwise forbid.
    await expect(createSubmission(db, scope, conversation.id)).resolves.toBeDefined();

    const rows = await db.select().from(submissions).where(eq(submissions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe(conversation.id);
  });
});
