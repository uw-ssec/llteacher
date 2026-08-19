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

describe("canReadSectionConversation (#27)", () => {
  const cases: Array<{
    name: string;
    conversation: { ownerUserId: string; isTeacherTest: boolean };
    viewer: { userId: string; isInstructor: boolean };
    expected: boolean;
  }> = [
    {
      name: "owner reads their own",
      conversation: STUDENT_CONV,
      viewer: { userId: "student-1", isInstructor: false },
      expected: true,
    },
    {
      name: "student cannot read another student's",
      conversation: OTHER_STUDENT_CONV,
      viewer: { userId: "student-1", isInstructor: false },
      expected: false,
    },
    {
      name: "instructor reads a student's",
      conversation: STUDENT_CONV,
      viewer: { userId: "instructor-1", isInstructor: true },
      expected: true,
    },
    {
      name: "instructor reads their own test conversation",
      conversation: MY_TEST_CONV,
      viewer: { userId: "instructor-1", isInstructor: true },
      expected: true,
    },
    {
      name: "instructor cannot read another instructor's test conversation",
      conversation: OTHER_INSTRUCTOR_TEST_CONV,
      viewer: { userId: "instructor-1", isInstructor: true },
      expected: false,
    },
    {
      name: "student cannot read an instructor's test conversation",
      conversation: OTHER_INSTRUCTOR_TEST_CONV,
      viewer: { userId: "student-1", isInstructor: false },
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
    expect(canReadSectionConversation(STUDENT_CONV, { userId: "instructor-1", isInstructor: true })).toBe(
      true,
    );
    expect(canWriteSectionConversation(STUDENT_CONV, { userId: "instructor-1" })).toBe(false);
  });
});
