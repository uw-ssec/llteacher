/* --------------------------------------------------------------------------
   #75: the grading routes.

   repositories/grades.test.ts owns the data invariants against a real
   Postgres. This file owns the request contract -- who is admitted, which
   bodies are refused, and the one thing a route can get wrong that the
   repository cannot: attributing a grade to a grader the CLIENT named.
   -------------------------------------------------------------------------- */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { draftGradeHandler, listGradesHandler, saveGradeHandler } from "./grades";
import { SubmissionNotInCourseError } from "../repositories/grades";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored", OPENROUTER_API_KEY: "sk-test" } as Env;
const SUBMISSION_ID = "11111111-2222-4333-8444-555555555555";
const GRADE_ID = "11111111-2222-4333-8444-555555555556";

const listGradesMock = vi.fn();
const recordHumanGradeMock = vi.fn();
const graderMembershipForMock = vi.fn();
const getSubmissionInCourseMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const auditBestEffortMock = vi.fn();

vi.mock("../repositories/grades", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repositories/grades")>()),
  listGradesForSubmission: (...a: unknown[]) => listGradesMock(...a),
  recordHumanGrade: (...a: unknown[]) => recordHumanGradeMock(...a),
  recordAiDraft: async () => GRADE_ID,
  graderMembershipFor: (...a: unknown[]) => graderMembershipForMock(...a),
  getSubmissionInCourse: (...a: unknown[]) => getSubmissionInCourseMock(...a),
}));
vi.mock("../repositories/organizations", () => ({
  getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a),
}));
vi.mock("../utils/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/audit")>()),
  auditBestEffort: (...a: unknown[]) => auditBestEffortMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({ select: () => ({ from: () => ({ innerJoin: () => ({ leftJoin: () => ({ where: async () => [] }), where: async () => [] }), where: async () => [] }) }) }) }));
vi.mock("../../lib/secrets-loader", () => ({ loadIdentityCipherKeys: async () => ({}) }));
vi.mock("../../lib/crypto/identity-cipher", () => ({ IdentityCipher: class {} }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  const base = "/api/courses/:courseId/submissions/:submissionId/grades";
  app.get(base, (c) => listGradesHandler(c));
  app.post(base, (c) => saveGradeHandler(c));
  app.post(`${base}/draft`, (c) => draftGradeHandler(c));
  return app;
}

const instructorOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] });
const taOfA = () =>
  fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] });

const url = (suffix = "") =>
  `/api/courses/course-a/submissions/${SUBMISSION_ID}/grades${suffix}`;
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  listGradesMock.mockReset().mockResolvedValue([]);
  recordHumanGradeMock.mockReset().mockResolvedValue(GRADE_ID);
  graderMembershipForMock.mockReset().mockResolvedValue("membership-1");
  getSubmissionInCourseMock
    .mockReset()
    .mockResolvedValue({ submissionId: SUBMISSION_ID, conversationId: "conv-1", studentUserId: "u-student" });
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  auditBestEffortMock.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("grading authorization (#75)", () => {
  const cases: [string, RequestInit | undefined, string][] = [
    ["GET grades", undefined, url()],
    ["POST grade", json({ score: 80, maxScore: 100, feedback: "ok" }), url()],
    ["POST draft", json({}), url("/draft")],
  ];

  for (const [label, init, path] of cases) {
    it(`denies a TA on ${label}`, async () => {
      // A TA may READ student work (#172) but a grade is an education record
      // the student may dispute -- a different authority.
      expect((await buildApp(taOfA()).request(path, init, TEST_ENV)).status).toBe(403);
    });
    it(`denies an instructor of another course on ${label}`, async () => {
      const other = fakeAuthContext({
        memberships: [fakeMembership({ courseId: "course-z", role: "instructor" })],
      });
      expect((await buildApp(other).request(path, init, TEST_ENV)).status).toBe(403);
    });
  }
});

describe("POST grade (#75)", () => {
  const post = (body: unknown) => buildApp(instructorOfA()).request(url(), json(body), TEST_ENV);

  it("attributes the grade to the CALLER's membership, never one from the body", async () => {
    // A grader field the client supplies is a grader field the client can
    // forge -- and a grade names who stands behind it.
    await post({ score: 80, maxScore: 100, feedback: "ok", graderMembershipId: "someone-else" });
    expect(recordHumanGradeMock.mock.calls[0]![3]).toMatchObject({
      graderMembershipId: "membership-1",
    });
  });

  it("refuses to grade when the caller's own membership may not grade", async () => {
    graderMembershipForMock.mockResolvedValue(null);
    expect((await post({ score: 80, maxScore: 100, feedback: "ok" })).status).toBe(403);
    expect(recordHumanGradeMock).not.toHaveBeenCalled();
  });

  it("requires a score and its scale together, or neither", async () => {
    // "7" with no denominator is unreadable a term later; a denominator with
    // no score is a form half-filled.
    expect((await post({ score: 80, feedback: "ok" })).status).toBe(400);
    expect((await post({ maxScore: 100, feedback: "ok" })).status).toBe(400);
    expect((await post({ feedback: "Written comments only." })).status).toBe(201);
  });

  it("rejects a score outside its scale, and a non-finite one", async () => {
    expect((await post({ score: 101, maxScore: 100, feedback: "x" })).status).toBe(400);
    expect((await post({ score: -1, maxScore: 100, feedback: "x" })).status).toBe(400);
    expect((await post({ score: 1, maxScore: 0, feedback: "x" })).status).toBe(400);
    const res = await buildApp(instructorOfA()).request(
      url(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // JSON admits 1e999, which parses to Infinity and slips past a naive
        // range comparison into a double column.
        body: '{"score":1e999,"maxScore":100,"feedback":"x"}',
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(recordHumanGradeMock).not.toHaveBeenCalled();
  });

  it("rejects an entirely empty grade", async () => {
    expect((await post({ feedback: "   " })).status).toBe(400);
  });

  it("404s a submission from another course", async () => {
    recordHumanGradeMock.mockRejectedValue(new SubmissionNotInCourseError());
    expect((await post({ score: 80, maxScore: 100, feedback: "x" })).status).toBe(404);
  });

  it("audits the score but never the written feedback", async () => {
    await post({ score: 80, maxScore: 100, feedback: "Ada misread the null hypothesis." });
    const metadata = auditBestEffortMock.mock.calls[0]![2].requestMetadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ score: 80, maxScore: 100 });
    // Written comments about a named student are the education record
    // itself; the audit log is for who-did-what, not a second copy.
    expect(JSON.stringify(metadata)).not.toContain("null hypothesis");
  });

  it("records that a grade came from a draft", async () => {
    await post({ score: 82, maxScore: 100, feedback: "Edited.", supersedesGradeId: GRADE_ID });
    expect(recordHumanGradeMock.mock.calls[0]![3]).toMatchObject({ supersedesGradeId: GRADE_ID });
    expect(auditBestEffortMock.mock.calls[0]![2].requestMetadata).toMatchObject({ fromDraft: true });
  });

  it("rejects a malformed draft reference", async () => {
    expect(
      (await post({ score: 1, maxScore: 10, feedback: "x", supersedesGradeId: "nope" })).status,
    ).toBe(400);
  });
});

describe("GET grades (#75)", () => {
  it("404s a malformed submission id without reaching the database", async () => {
    const res = await buildApp(instructorOfA()).request(
      "/api/courses/course-a/submissions/not-a-uuid/grades",
      undefined,
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(listGradesMock).not.toHaveBeenCalled();
  });

  it("404s a submission from another course", async () => {
    listGradesMock.mockRejectedValue(new SubmissionNotInCourseError());
    expect((await buildApp(instructorOfA()).request(url(), undefined, TEST_ENV)).status).toBe(404);
  });
});

describe("POST draft (#75)", () => {
  it("503s with an actionable sentence when the gateway is unconfigured", async () => {
    const res = await buildApp(instructorOfA()).request(
      url("/draft"),
      json({}),
      { DATABASE_URL: "ignored" } as Env,
    );
    expect(res.status).toBe(503);
  });

  it("404s a submission that is not in this course", async () => {
    getSubmissionInCourseMock.mockResolvedValue(null);
    expect((await buildApp(instructorOfA()).request(url("/draft"), json({}), TEST_ENV)).status).toBe(
      404,
    );
  });
});
