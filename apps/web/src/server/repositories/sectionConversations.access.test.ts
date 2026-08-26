import { describe, it, expect } from "vitest";
import { canReadSectionConversation, canWriteSectionConversation } from "./sectionConversations";

/* --------------------------------------------------------------------------
   #27's access matrix, as a table.

   These are pure functions on purpose: the rule is the thing worth pinning,
   and a table test states it in a form a reviewer can check against the
   requirement without reading a route handler or a db double.
   -------------------------------------------------------------------------- */

const STUDENT_CONV = { ownerUserId: "student-1", isTeacherTest: false };
const OTHER_STUDENT_CONV = { ownerUserId: "student-2", isTeacherTest: false };
const MY_TEST_CONV = { ownerUserId: "instructor-1", isTeacherTest: true };
const OTHER_INSTRUCTOR_TEST_CONV = { ownerUserId: "instructor-2", isTeacherTest: true };

describe("canReadSectionConversation (#27, widened to grader tier by #246)", () => {
  const cases: Array<{
    name: string;
    conversation: { ownerUserId: string; isTeacherTest: boolean };
    viewer: { userId: string; isGrader: boolean };
    expected: boolean;
  }> = [
    {
      name: "owner reads their own",
      conversation: STUDENT_CONV,
      viewer: { userId: "student-1", isGrader: false },
      expected: true,
    },
    {
      name: "student cannot read another student's",
      conversation: OTHER_STUDENT_CONV,
      viewer: { userId: "student-1", isGrader: false },
      expected: false,
    },
    {
      name: "instructor reads a student's",
      conversation: STUDENT_CONV,
      viewer: { userId: "instructor-1", isGrader: true },
      expected: true,
    },
    {
      name: "instructor reads their own test conversation",
      conversation: MY_TEST_CONV,
      viewer: { userId: "instructor-1", isGrader: true },
      expected: true,
    },
    {
      name: "instructor cannot read another instructor's test conversation",
      conversation: OTHER_INSTRUCTOR_TEST_CONV,
      viewer: { userId: "instructor-1", isGrader: true },
      expected: false,
    },
    {
      name: "student cannot read an instructor's test conversation",
      conversation: OTHER_INSTRUCTOR_TEST_CONV,
      viewer: { userId: "student-1", isGrader: false },
      expected: false,
    },
    {
      // #246: the tier this task adds -- a TA of the course is a grader
      // (GRADER_ROLES) and must be able to open the transcript behind a
      // submission the requireGraderOf-gated dashboard already shows them.
      name: "TA reads a student's non-teacher-test conversation",
      conversation: STUDENT_CONV,
      viewer: { userId: "ta-1", isGrader: true },
      expected: true,
    },
    {
      // A TA of a *different* course is not a grader of this course --
      // isGraderOf is course-scoped, so this is what authContext.isGraderOf
      // resolves to for that caller and this conversation's course.
      name: "TA of a different course cannot read",
      conversation: STUDENT_CONV,
      viewer: { userId: "ta-of-other-course", isGrader: false },
      expected: false,
    },
    {
      // Same exclusion the instructor cases above pin: grader tier widens
      // *who* may read, not *what* a teacher-test conversation hides. A TA
      // gets no more access to another grader's scratch work than an
      // instructor does.
      name: "TA cannot read another instructor's teacher-test conversation",
      conversation: OTHER_INSTRUCTOR_TEST_CONV,
      viewer: { userId: "ta-1", isGrader: true },
      expected: false,
    },
  ];

  it.each(cases)("$name", ({ conversation, viewer, expected }) => {
    expect(canReadSectionConversation(conversation, viewer)).toBe(expected);
  });
});

describe("canWriteSectionConversation (#27)", () => {
  it("permits the owner", () => {
    expect(canWriteSectionConversation(STUDENT_CONV, { userId: "student-1" })).toBe(true);
  });

  it("refuses an instructor who may read the same conversation", () => {
    // Read access is not write access: an instructor who could append turns
    // to a student's transcript would make the submitted record no longer
    // the student's own work.
    expect(canReadSectionConversation(STUDENT_CONV, { userId: "instructor-1", isGrader: true })).toBe(
      true,
    );
    expect(canWriteSectionConversation(STUDENT_CONV, { userId: "instructor-1" })).toBe(false);
  });
});
