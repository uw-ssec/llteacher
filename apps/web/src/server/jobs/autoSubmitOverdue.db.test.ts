/* --------------------------------------------------------------------------
   #167: the overdue auto-submit sweep, against a real Postgres.

   This has to be a real-DB suite. The two things most worth proving --
   that a second run creates no duplicate, and that a concurrent run does
   not error -- are both properties of a unique index and an ON CONFLICT DO
   NOTHING clause. A mocked db cannot evaluate either, so a mocked version
   of these tests would pass whether or not the job were idempotent at all.

   Skipped without DATABASE_URL, matching every other real-DB suite here.
   CI provides one.
   -------------------------------------------------------------------------- */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeNodeDb } from "../../db/nodeClient";
import type { Db } from "../../db/client";
import {
  autoSubmitOverdueSections,
  autoSubmitOverdueSectionsForOrg,

  AUTO_SUBMIT_LOG_CONTEXT,
} from "./autoSubmitOverdue";
import { unsafeOrgScope, unsafeCourseScope } from "../repositories/scope";
import { getHomeworkSubmissionsMatrix, findOverdueSubmissionCandidates } from "../repositories/submissions";
import { getStudentHomeworksForUser } from "../repositories/studentHomeworks";
import { IdentityCipher } from "../../lib/crypto/identity-cipher";
import { loadIdentityCipherKeys } from "../../lib/secrets-loader";
import {
  organizations,
  courses,
  users,
  courseMemberships,
  homeworks,
  sections,
  conversations,
  messages,
  submissions,
} from "../../db/schema";

const DATABASE_URL = process.env.DATABASE_URL;

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe.skipIf(!DATABASE_URL)("autoSubmitOverdueSections (real DB, #167)", () => {
  let db: Db;
  let cipher: IdentityCipher;
  /** Orgs created by this suite, torn down in afterAll. Every other fixture
   *  row hangs off one of them by a cascading FK. */
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    db = makeNodeDb(DATABASE_URL!);
    cipher = new IdentityCipher(
      await loadIdentityCipherKeys({
        ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
        BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      } as Env),
    );
  });

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await db.delete(organizations).where(eq(organizations.id, id));
    }
  });

  /** One org + course + instructor, isolated from every other test in this
   *  file (and from the rest of the suite's data) so the sweep's own
   *  "every organization" pass can be asserted on without depending on what
   *  else happens to be in the database. */
  async function seedOrg(label: string) {
    const [org] = await db
      .insert(organizations)
      .values({
        name: `167-${label}`,
        slug: `s167-${crypto.randomUUID()}`,
        workosOrganizationId: `org167_${crypto.randomUUID()}`,
      })
      .returning();
    createdOrgIds.push(org!.id);

    const [course] = await db
      .insert(courses)
      .values({ organizationId: org!.id, code: `C167-${label}`, term: "T", title: `Course ${label}` })
      .returning();

    // homeworks.created_by_id is an FK to course_memberships, so the author
    // needs its own instructor membership.
    const [instructor] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString(`i-${crypto.randomUUID()}@test.example`),
        emailBlindIndex: await cipher.computeBlindIndex(`i-${crypto.randomUUID()}@test.example`),
      })
      .returning();
    const [instructorMembership] = await db
      .insert(courseMemberships)
      .values({ userId: instructor!.id, courseId: course!.id, role: "instructor" })
      .returning();

    return {
      orgId: org!.id,
      courseId: course!.id,
      instructorMembershipId: instructorMembership!.id,
      scope: unsafeOrgScope(org!.id),
    };
  }

  async function seedStudent(courseId: string, email: string) {
    const [user] = await db
      .insert(users)
      .values({
        email: await cipher.encryptString(email),
        emailBlindIndex: await cipher.computeBlindIndex(IdentityCipher.normalizeEmail(email)),
        displayName: await cipher.encryptString(email.split("@")[0]!),
      })
      .returning();
    await db.insert(courseMemberships).values({ userId: user!.id, courseId, role: "student" });
    return user!.id;
  }

  /** `publishedAt` defaults to "published a day ago" and `dueDate` to "an
   *  hour ago" -- i.e. the ordinary past-due case -- so each test only
   *  states the one attribute it is actually about. */
  async function seedHomeworkWithSection(
    org: { courseId: string; instructorMembershipId: string },
    overrides: Partial<{
      dueDate: Date;
      publishedAt: Date | null;
      releasedAt: Date | null;
      isHidden: boolean;
      expiresAt: Date | null;
      title: string;
    }> = {},
  ) {
    const [hw] = await db
      .insert(homeworks)
      .values({
        courseId: org.courseId,
        createdById: org.instructorMembershipId,
        title: overrides.title ?? "hw",
        description: "d",
        dueDate: overrides.dueDate ?? new Date(Date.now() - HOUR),
        publishedAt: overrides.publishedAt === undefined ? new Date(Date.now() - DAY) : overrides.publishedAt,
        releasedAt: overrides.releasedAt ?? null,
        isHidden: overrides.isHidden ?? false,
        expiresAt: overrides.expiresAt ?? null,
      })
      .returning();
    const [section] = await db
      .insert(sections)
      .values({ homeworkId: hw!.id, title: "s", content: "c", order: 1 })
      .returning();
    return { homeworkId: hw!.id, sectionId: section!.id };
  }

  /** Models what startSectionConversation actually writes: a conversation
   *  plus an assistant greeting. `studentWrote` then adds a message of the
   *  student's own -- true by default, because a conversation a student
   *  worked in is the ordinary case, and `false` is the #318 "clicked in,
   *  read the greeting, left" case the sweep must not treat as work. */
  async function seedConversation(
    args: { userId: string; courseId: string; sectionId: string | null },
    overrides: Partial<{
      isDeleted: boolean;
      isTeacherTest: boolean;
      kind: "section" | "tutor";
      studentWrote: boolean;
    }> = {},
  ) {
    const [conv] = await db
      .insert(conversations)
      .values({
        ownerUserId: args.userId,
        courseId: args.courseId,
        sectionId: args.sectionId,
        kind: overrides.kind ?? "section",
        title: "c",
        isDeleted: overrides.isDeleted ?? false,
        isTeacherTest: overrides.isTeacherTest ?? false,
        ...(overrides.isDeleted ? { deletedAt: new Date() } : {}),
      })
      .returning();
    // The greeting startSectionConversation writes at creation time -- present
    // on every real section conversation, and never the student's own work.
    await db.insert(messages).values({
      conversationId: conv!.id,
      role: "assistant",
      parts: [{ type: "text", text: "greeting" }],
    });
    if (overrides.studentWrote !== false) {
      await db.insert(messages).values({
        conversationId: conv!.id,
        role: "user",
        parts: [{ type: "text", text: "my attempt" }],
      });
    }
    return conv!.id;
  }

  function submissionsForOrg(orgId: string) {
    return db.select().from(submissions).where(eq(submissions.organizationId, orgId));
  }

  it("submits a past-due section with a live conversation, marked source=auto", async () => {
    const org = await seedOrg("basic");
    const student = await seedStudent(org.courseId, `basic-${crypto.randomUUID()}@test.example`);
    const { sectionId } = await seedHomeworkWithSection(org);
    const conversationId = await seedConversation({ userId: student, courseId: org.courseId, sectionId });

    const summary = await autoSubmitOverdueSectionsForOrg(db, org.scope);

    expect(summary).toEqual({ candidates: 1, submitted: 1, skipped: 0, failed: 0 });
    const rows = await submissionsForOrg(org.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("auto");
    expect(rows[0]!.conversationId).toBe(conversationId);
    // The denormalized pair is written from the conversation the candidate
    // query read, not guessed -- the composite FK would reject a mismatch,
    // but asserting it here says what the row is supposed to mean.
    expect(rows[0]!.userId).toBe(student);
    expect(rows[0]!.sectionId).toBe(sectionId);
  });

  it("is idempotent: running twice leaves exactly one row and does not throw", async () => {
    const org = await seedOrg("idempotent");
    const student = await seedStudent(org.courseId, `idem-${crypto.randomUUID()}@test.example`);
    const { sectionId } = await seedHomeworkWithSection(org);
    await seedConversation({ userId: student, courseId: org.courseId, sectionId });

    const first = await autoSubmitOverdueSectionsForOrg(db, org.scope);
    // Genuinely run again rather than asserting a guard would have stopped
    // it: the claim under test is that a re-run is harmless, and only a
    // re-run can demonstrate that.
    const second = await autoSubmitOverdueSectionsForOrg(db, org.scope);

    expect(first.submitted).toBe(1);
    // The section is no longer a candidate at all on the second pass -- the
    // (user, section) left join finds the row the first pass wrote.
    expect(second).toEqual({ candidates: 0, submitted: 0, skipped: 0, failed: 0 });
    expect(await submissionsForOrg(org.orgId)).toHaveLength(1);
  });

  it("two concurrent runs still produce exactly one row, with no failure", async () => {
    const org = await seedOrg("concurrent");
    const student = await seedStudent(org.courseId, `conc-${crypto.randomUUID()}@test.example`);
    const { sectionId } = await seedHomeworkWithSection(org);
    await seedConversation({ userId: student, courseId: org.courseId, sectionId });

    // The overlapping-cron-invocation case, and the reason idempotency is
    // ON CONFLICT DO NOTHING rather than a read-then-insert: with a prior
    // existence check, whichever run read first would go on to insert a
    // duplicate (rejected by the unique index, so: a thrown error and a
    // `failed` count), because its check happened before the other run's
    // write. The assertions below hold for every interleaving -- whether
    // the second run loses the race at the query (candidates 0) or at the
    // insert (skipped 1), it neither duplicates nor errors.
    const [a, b] = await Promise.all([
      autoSubmitOverdueSectionsForOrg(db, org.scope),
      autoSubmitOverdueSectionsForOrg(db, org.scope),
    ]);

    expect(await submissionsForOrg(org.orgId)).toHaveLength(1);
    expect(a.submitted + b.submitted).toBe(1);
    expect(a.failed + b.failed).toBe(0);
  });

  it("skips sections that are not due, already submitted, unstarted, teacher-test, or unreleased", async () => {
    const org = await seedOrg("skips");
    const student = await seedStudent(org.courseId, `skip-${crypto.randomUUID()}@test.example`);

    // (1) Not past due.
    const notDue = await seedHomeworkWithSection(org, { dueDate: new Date(Date.now() + DAY), title: "not-due" });
    await seedConversation({ userId: student, courseId: org.courseId, sectionId: notDue.sectionId });

    // (2) Past due, but the student already submitted it themselves. The
    //     pre-existing row must survive untouched -- in particular its
    //     source must stay "student".
    const already = await seedHomeworkWithSection(org, { title: "already" });
    const alreadyConv = await seedConversation({
      userId: student, courseId: org.courseId, sectionId: already.sectionId,
    });
    await db.insert(submissions).values({
      conversationId: alreadyConv,
      userId: student,
      sectionId: already.sectionId,
      organizationId: org.orgId,
    });

    // (3) Past due with no live conversation: the student started and
    //     restarted, leaving only a soft-deleted row.
    const restarted = await seedHomeworkWithSection(org, { title: "restarted" });
    await seedConversation(
      { userId: student, courseId: org.courseId, sectionId: restarted.sectionId },
      { isDeleted: true },
    );

    // (4) Past due, but the conversation is an instructor's own test run.
    const teacherTest = await seedHomeworkWithSection(org, { title: "teacher-test" });
    await seedConversation(
      { userId: student, courseId: org.courseId, sectionId: teacherTest.sectionId },
      { isTeacherTest: true },
    );

    // (5) Past due but never published -- a draft.
    const draft = await seedHomeworkWithSection(org, { publishedAt: null, title: "draft" });
    await seedConversation({ userId: student, courseId: org.courseId, sectionId: draft.sectionId });

    // (6) Past due but hidden, and (7) past due but expired -- the two
    //     states that make the manual submit route refuse with
    //     HomeworkClosedError, so the sweep must not walk around it.
    const hidden = await seedHomeworkWithSection(org, { isHidden: true, title: "hidden" });
    await seedConversation({ userId: student, courseId: org.courseId, sectionId: hidden.sectionId });
    const expired = await seedHomeworkWithSection(org, {
      expiresAt: new Date(Date.now() - HOUR), title: "expired",
    });
    await seedConversation({ userId: student, courseId: org.courseId, sectionId: expired.sectionId });

    const summary = await autoSubmitOverdueSectionsForOrg(db, org.scope);

    expect(summary).toEqual({ candidates: 0, submitted: 0, skipped: 0, failed: 0 });
    const rows = await submissionsForOrg(org.orgId);
    // Only the one the student made themselves, unchanged.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversationId).toBe(alreadyConv);
    expect(rows[0]!.source).toBe("student");
  });

  it("skips a conversation the student opened but never wrote in (#167 review)", async () => {
    const org = await seedOrg("greeting-only");
    const student = await seedStudent(org.courseId, `greet-${crypto.randomUUID()}@test.example`);
    const { sectionId } = await seedHomeworkWithSection(org);
    // Exactly what #318's eager creation leaves behind when a student clicks
    // into a past-due section, sees the greeting, and leaves: a live,
    // non-teacher-test conversation on a past-due section with no
    // submission -- every structural condition satisfied except the one
    // that matters, that the student did anything.
    await seedConversation(
      { userId: student, courseId: org.courseId, sectionId },
      { studentWrote: false },
    );

    const summary = await autoSubmitOverdueSectionsForOrg(db, org.scope);

    expect(summary).toEqual({ candidates: 0, submitted: 0, skipped: 0, failed: 0 });
    expect(await submissionsForOrg(org.orgId)).toHaveLength(0);
  });

  it("still submits once the student has written even one message", async () => {
    // The other side of the clause above -- it gates on the student having
    // spoken, not on any threshold of how much, so a single message is work.
    const org = await seedOrg("one-message");
    const student = await seedStudent(org.courseId, `one-${crypto.randomUUID()}@test.example`);
    const { sectionId } = await seedHomeworkWithSection(org);
    await seedConversation({ userId: student, courseId: org.courseId, sectionId });

    const summary = await autoSubmitOverdueSectionsForOrg(db, org.scope);

    expect(summary.submitted).toBe(1);
    expect(await submissionsForOrg(org.orgId)).toHaveLength(1);
  });

  it("does not touch a tutor conversation", async () => {
    const org = await seedOrg("tutor");
    const student = await seedStudent(org.courseId, `tutor-${crypto.randomUUID()}@test.example`);
    await seedHomeworkWithSection(org);
    await seedConversation(
      { userId: student, courseId: org.courseId, sectionId: null },
      { kind: "tutor" },
    );

    const summary = await autoSubmitOverdueSectionsForOrg(db, org.scope);

    expect(summary.candidates).toBe(0);
    expect(await submissionsForOrg(org.orgId)).toHaveLength(0);
  });

  it("scopes to one organization: a sibling org's overdue work is untouched", async () => {
    const orgA = await seedOrg("tenant-a");
    const orgB = await seedOrg("tenant-b");
    const studentA = await seedStudent(orgA.courseId, `ta-${crypto.randomUUID()}@test.example`);
    const studentB = await seedStudent(orgB.courseId, `tb-${crypto.randomUUID()}@test.example`);
    const sectionA = await seedHomeworkWithSection(orgA);
    const sectionB = await seedHomeworkWithSection(orgB);
    await seedConversation({ userId: studentA, courseId: orgA.courseId, sectionId: sectionA.sectionId });
    await seedConversation({ userId: studentB, courseId: orgB.courseId, sectionId: sectionB.sectionId });

    // The candidate query itself must not see across the boundary -- not
    // just the insert. A sweep that read every tenant's rows and then
    // filtered before writing would still be a cross-tenant read.
    const candidatesA = await findOverdueSubmissionCandidates(db, orgA.scope);
    expect(candidatesA.map((c) => c.userId)).toEqual([studentA]);

    await autoSubmitOverdueSectionsForOrg(db, orgA.scope);

    expect(await submissionsForOrg(orgA.orgId)).toHaveLength(1);
    expect(await submissionsForOrg(orgB.orgId)).toHaveLength(0);
  });

  it("counts submitted, skipped and failed accurately across a mixed batch, and logs one summary line", async () => {
    const org = await seedOrg("counts");
    const willSubmit = await seedStudent(org.courseId, `ok-${crypto.randomUUID()}@test.example`);
    const willFail = await seedStudent(org.courseId, `fail-${crypto.randomUUID()}@test.example`);
    const willSkip = await seedStudent(org.courseId, `skip-${crypto.randomUUID()}@test.example`);
    const { sectionId } = await seedHomeworkWithSection(org);
    await seedConversation({ userId: willSubmit, courseId: org.courseId, sectionId });
    const failingConv = await seedConversation({ userId: willFail, courseId: org.courseId, sectionId });
    const skippingConv = await seedConversation({ userId: willSkip, courseId: org.courseId, sectionId });

    // A student who submits between this run's candidate read and its
    // write. Simulated by letting the candidate query see all three and
    // then writing the row underneath one of them -- the ON CONFLICT DO
    // NOTHING path, which is what `skipped` counts.
    const staleCandidates = await findOverdueSubmissionCandidates(db, org.scope);
    expect(staleCandidates).toHaveLength(3);

    const failingDb = withFailures(db, {
      failInsertFor: failingConv,
      beforeFirstInsert: async () => {
        await db.insert(submissions).values({
          conversationId: skippingConv,
          userId: willSkip,
          sectionId,
          organizationId: org.orgId,
        });
      },
    });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const summary = await autoSubmitOverdueSectionsForOrg(failingDb, org.scope);
      expect(summary).toEqual({ candidates: 3, submitted: 1, skipped: 1, failed: 1 });

      // One failing row is logged individually and does not abort the run:
      // the other two candidates were still processed above.
      const errorLine = JSON.parse(errorSpy.mock.calls.at(-1)![0] as string);
      expect(errorLine).toMatchObject({
        level: "error",
        context: AUTO_SUBMIT_LOG_CONTEXT,
        organizationId: org.orgId,
        conversationId: failingConv,
      });

      // The failed candidate is genuinely unsubmitted -- a `failed` count
      // that coexisted with a written row would be worse than no count.
      const afterMixed = await submissionsForOrg(org.orgId);
      expect(afterMixed.map((r) => r.conversationId)).not.toContain(failingConv);

      // The whole-platform entry point emits exactly one structured summary
      // line per run, whatever the per-row outcomes were. Run here against
      // the REAL db, which doubles as the recovery assertion below: nothing
      // about a candidate is consumed by a failed attempt, so the next
      // scheduled run picks it up again with no retry infrastructure.
      infoSpy.mockClear();
      await autoSubmitOverdueSections(db);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const summaryLine = JSON.parse(infoSpy.mock.calls[0]![0] as string);
      expect(summaryLine).toMatchObject({ level: "info", context: AUTO_SUBMIT_LOG_CONTEXT });
      expect(summaryLine).toHaveProperty("candidates");
      expect(summaryLine).toHaveProperty("submitted");
      expect(summaryLine).toHaveProperty("skipped");
      expect(summaryLine).toHaveProperty("failed");
      expect(summaryLine).toHaveProperty("organizations");
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }

    const recovered = await submissionsForOrg(org.orgId);
    expect(recovered.map((r) => r.conversationId)).toContain(failingConv);
  });

  it("surfaces the auto/student distinction on both the instructor matrix and the student's own view", async () => {
    const org = await seedOrg("dashboard");
    const autoStudent = await seedStudent(org.courseId, `auto-${crypto.randomUUID()}@test.example`);
    const manualStudent = await seedStudent(org.courseId, `manual-${crypto.randomUUID()}@test.example`);
    const { homeworkId, sectionId } = await seedHomeworkWithSection(org);
    await seedConversation({ userId: autoStudent, courseId: org.courseId, sectionId });
    const manualConv = await seedConversation({
      userId: manualStudent, courseId: org.courseId, sectionId,
    });
    await db.insert(submissions).values({
      conversationId: manualConv, userId: manualStudent, sectionId, organizationId: org.orgId,
    });

    await autoSubmitOverdueSectionsForOrg(db, org.scope);

    const matrix = await getHomeworkSubmissionsMatrix(
      db, unsafeCourseScope(org.courseId), cipher, homeworkId,
    );
    const autoCell = matrix!.students.find((s) => s.studentId === autoStudent)!.sections[0]!;
    const manualCell = matrix!.students.find((s) => s.studentId === manualStudent)!.sections[0]!;
    // Both are genuinely submitted -- the distinction is provenance, not
    // status, which is exactly why it is a separate field.
    expect(autoCell.status).toBe("submitted");
    expect(manualCell.status).toBe("submitted");
    expect(autoCell.submissionSource).toBe("auto");
    expect(manualCell.submissionSource).toBe("student");

    const autoView = await getStudentHomeworksForUser(db, autoStudent);
    const manualView = await getStudentHomeworksForUser(db, manualStudent);
    const autoSection = autoView.find((h) => h.id === homeworkId)!.sections[0]!;
    const manualSection = manualView.find((h) => h.id === homeworkId)!.sections[0]!;
    expect(autoSection.status).toBe("submitted");
    expect(autoSection.submissionSource).toBe("auto");
    expect(manualSection.submissionSource).toBe("student");
  });
});

/** A `Db` that behaves exactly like the real one except for two injected
 *  events on `insert`: a hook fired immediately before the first insert
 *  (used to write a row underneath an already-read candidate, reproducing
 *  the submit-during-the-run race), and one conversation id whose insert
 *  rejects (reproducing a row-level failure -- the FK breaking because the
 *  conversation was deleted mid-run, say).
 *
 *  A proxy rather than a hand-built fake: everything else in the job --
 *  the candidate join, the ON CONFLICT clause, the unique index that
 *  enforces it -- must stay real, because those are the parts under test.
 *  Only the two events that cannot be scheduled deterministically from
 *  outside are injected. */
function withFailures(
  real: Db,
  opts: { failInsertFor: string; beforeFirstInsert: () => Promise<void> },
): Db {
  let firstInsertPending = true;
  return new Proxy(real as object, {
    get(target, prop) {
      // Bound to the real database, never to the proxy, so drizzle's own
      // internals are unaffected by being reached through it.
      const value = Reflect.get(target, prop, target);
      if (prop !== "insert" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (table: unknown) => {
        const builder = (value as (t: unknown) => { values: (v: unknown) => unknown }).call(target, table);
        return {
          values: (row: { conversationId?: string }) => ({
            onConflictDoNothing: () => ({
              returning: async (columns?: unknown) => {
                if (firstInsertPending) {
                  firstInsertPending = false;
                  await opts.beforeFirstInsert();
                }
                if (row.conversationId === opts.failInsertFor) {
                  throw new Error("forced insert failure");
                }
                const chained = builder.values(row) as {
                  onConflictDoNothing: () => { returning: (c?: unknown) => Promise<unknown[]> };
                };
                return chained.onConflictDoNothing().returning(columns);
              },
            }),
          }),
        };
      };
    },
  }) as Db;
}
