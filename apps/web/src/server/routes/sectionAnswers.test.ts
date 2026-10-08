import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { submitSectionAnswerHandler, getSectionAnswerHandler } from "./sectionAnswers";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import type { SectionAnswerResponse } from "../../shared/types";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import {
  SectionAnswerSectionNotFoundError,
  SectionNotAnswerableError,
  SectionAnswerHomeworkClosedError,
} from "../repositories/sectionAnswers";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
/** A syntactically valid section id. These tests used to pass "sec-1", which
 *  only reached the (mocked) repository because the handler had no UUID
 *  guard; in production it raised Postgres's `invalid input syntax`. */
const SECTION_ID = "11111111-2222-4333-8444-555555555555";
const ANSWER_PATH = `/api/sections/${SECTION_ID}/answer`;

const upsertSectionAnswerMock = vi.fn();
const getSectionAnswerMock = vi.fn();
// importOriginal, not a bare factory: the handler now names the typed
// refusal classes upsertSectionAnswer throws, and a factory that omits them
// leaves `instanceof undefined` to throw inside query's classifier.
vi.mock("../repositories/sectionAnswers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/sectionAnswers")>();
  return {
    ...actual,
    upsertSectionAnswer: (...a: unknown[]) => upsertSectionAnswerMock(...a),
    getSectionAnswer: (...a: unknown[]) => getSectionAnswerMock(...a),
  };
});
const getOrgScopesForUserMock = vi.fn();
vi.mock("../repositories/users", () => ({ getOrgScopesForUser: (...a: unknown[]) => getOrgScopesForUserMock(...a) }));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));


function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { if (authContext) c.set("authContext", authContext); await next(); });
  app.patch("/api/sections/:sectionId/answer", (c) => submitSectionAnswerHandler(c));
  app.get("/api/courses/:courseId/sections/:sectionId/answers/:studentId", (c) => getSectionAnswerHandler(c));
  return app;
}

describe("PATCH /api/sections/:sectionId/answer", () => {
  it("denies a non-student with 403", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: () => false })).request(
      ANSWER_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when content is missing or empty", async () => {
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      ANSWER_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "   " }) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("submits and returns the answer", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    upsertSectionAnswerMock.mockReset().mockResolvedValue({
      id: "ans-1", sectionId: "sec-1", userId: "u1", content: "my answer",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"), homeworkStatus: "active",
    });
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      ANSWER_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "my answer" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SectionAnswerResponse;
    expect(body.content).toBe("my answer");
    expect(body.sectionId).toBe("sec-1");
  });

  it("maps a conversation-type-section repository error to 403", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    upsertSectionAnswerMock.mockReset().mockRejectedValue(new SectionNotAnswerableError());
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      ANSWER_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller has no organization membership", async () => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue([]);
    const res = await buildApp(fakeAuthContext({ hasRole: (r) => r === "student" })).request(
      ANSWER_PATH,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
  });
});

/** The refusals upsertSectionAnswer throws are now typed (they were plain
 *  Errors behind a bare catch), so the route translates exactly them and an
 *  outage is no longer reported as a refusal. */
describe("PATCH /api/sections/:sectionId/answer -- typed refusals", () => {
  const student = () => fakeAuthContext({ hasRole: (r) => r === "student" });
  const patch = (path = ANSWER_PATH, body: string = JSON.stringify({ content: "x" })) =>
    buildApp(student()).request(
      path,
      { method: "PATCH", headers: { "content-type": "application/json" }, body },
      TEST_ENV,
    );

  it.each([
    ["SectionAnswerSectionNotFoundError", () => new SectionAnswerSectionNotFoundError()],
    ["SectionNotAnswerableError", () => new SectionNotAnswerableError()],
    ["SectionAnswerHomeworkClosedError", () => new SectionAnswerHomeworkClosedError()],
  ] as const)("collapses %s into the same uniform 403", async (_name, make) => {
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    upsertSectionAnswerMock.mockReset().mockRejectedValue(make());
    const res = await patch();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Section not found or does not accept a direct answer" });
  });

  it("answers 503, not the refusal 403, when the database fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
    upsertSectionAnswerMock.mockReset().mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const res = await patch();
    expect(res.status).toBe(503);
    consoleSpy.mockRestore();
  });

  it("refuses a malformed sectionId with the same 403, without touching the database", async () => {
    getOrgScopesForUserMock.mockReset();
    upsertSectionAnswerMock.mockReset();
    const res = await patch("/api/sections/not-a-uuid/answer");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Section not found or does not accept a direct answer" });
    expect(getOrgScopesForUserMock).not.toHaveBeenCalled();
    expect(upsertSectionAnswerMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed JSON body", async () => {
    const res = await patch(ANSWER_PATH, "not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Request body must be valid JSON" });
  });
});

describe("GET .../answers/:studentId -- database failure", () => {
  it("answers 503 when getSectionAnswer fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getSectionAnswerMock.mockReset().mockRejectedValue(new Error("Connection terminated unexpectedly"));
    const res = await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })).request(
      "/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV,
    );
    expect(res.status).toBe(503);
    consoleSpy.mockRestore();
  });
});

describe("GET /api/courses/:courseId/sections/:sectionId/answers/:studentId", () => {
  it("denies a non-instructor with 403", async () => {
    const res = await buildApp(fakeAuthContext({ isInstructorOf: () => false })).request(
      "/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
  });

  // #174: courseScopeFromAuthContext (real, unmocked -- pure function) only
  // mints a scope when isMemberOf(courseId) is true, so both success-path
  // tests below must set it alongside isInstructorOf.
  it("returns 403 when isInstructorOf passes but isMemberOf doesn't (should be unreachable in practice)", async () => {
    getSectionAnswerMock.mockReset();
    const res = await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })], isMemberOf: () => false })).request(
      "/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(getSectionAnswerMock).not.toHaveBeenCalled();
  });

  it("returns 404 when no answer exists", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue(null);
    const res = await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })).request(
      "/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("passes a course-scoped (not org-scoped) query down to the repository", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue(null);
    await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })).request(
      "/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV,
    );
    expect(getSectionAnswerMock).toHaveBeenCalledWith(
      expect.anything(),
      "course-a",
      "11111111-2222-4333-8444-555555555556",
      "11111111-2222-4333-8444-555555555557",
    );
  });

  it("returns the found answer", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue({
      id: "ans-1", sectionId: "sec-1", userId: "student-1", content: "their answer",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z"), homeworkStatus: "active",
    });
    const res = await buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })).request(
      "/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SectionAnswerResponse;
    expect(body.content).toBe("their answer");
    expect(body.userId).toBe("student-1");
  });
});

/** #172: reading one student's answer is grading, so a TA of the course may
 *  do it without any capability grant -- same rationale as the submissions
 *  dashboard. Cross-course isolation from #174 must still hold. */
describe("GET .../answers/:studentId — grader access (#172)", () => {
  it("allows a TA with no capability grants at all", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue({
      id: "a1", sectionId: "sec-1", userId: "stu-1", content: "my answer",
      submittedAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"), homeworkStatus: "active",
    });
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
    ).request("/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV);
    expect(res.status).toBe(200);
  });

  it("denies a TA of a different course", async () => {
    getSectionAnswerMock.mockReset();
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-b", role: "ta" })] }),
    ).request("/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(getSectionAnswerMock).not.toHaveBeenCalled();
  });

  it("denies a student of the same course", async () => {
    getSectionAnswerMock.mockReset();
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "student" })] }),
    ).request("/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557", {}, TEST_ENV);
    expect(res.status).toBe(403);
  });
});

/** #172 audit (SEC-001), given real coverage by the re-audit (FUN-105).
 *
 *  The gate itself shipped correct. What did not ship was any test that
 *  evaluated it: every mock in this file returned an answer row with no
 *  `homeworkStatus` at all, so `isUnreleased(undefined)` was false on every
 *  path and the branch was dead in the suite. Deleting the gate outright
 *  left the file green.
 *
 *  Three cases, because the rule is three-way and each leg fails
 *  differently: an ungranted grader is refused, a granted TA is admitted,
 *  and a released homework is admitted regardless of the grant. */
describe("GET .../answers/:studentId — unreleased homework gate (#172, SEC-001)", () => {
  const answerWithStatus = (homeworkStatus: string) => ({
    id: "a1",
    sectionId: "sec-1",
    userId: "stu-1",
    content: "my answer",
    submittedAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    homeworkStatus,
  });

  const request = (authContext: ReturnType<typeof fakeAuthContext>) =>
    buildApp(authContext).request(
      "/api/courses/course-a/sections/11111111-2222-4333-8444-555555555556/answers/11111111-2222-4333-8444-555555555557",
      {},
      TEST_ENV,
    );

  // Every status the release gate treats as withheld, so adding one to
  // UNRELEASED_STATUSES without deciding this behaviour shows up here.
  it.each(["draft", "scheduled", "hidden"])(
    "hides a %s homework's answer from a TA without canViewDrafts",
    async (status) => {
      getSectionAnswerMock.mockReset().mockResolvedValue(answerWithStatus(status));
      const res = await request(
        fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
      );
      // 404, not 403: the same answer a nonexistent row gives, so a TA
      // cannot use this endpoint to discover that an unreleased homework
      // exists.
      expect(res.status).toBe(404);
    },
  );

  it.each(["draft", "scheduled", "hidden"])(
    "shows a %s homework's answer to a TA granted canViewDrafts",
    async (status) => {
      getSectionAnswerMock.mockReset().mockResolvedValue(answerWithStatus(status));
      const res = await request(
        fakeAuthContext({
          memberships: [
            fakeMembership({ courseId: "course-a", role: "ta", canViewDrafts: true }),
          ],
        }),
      );
      expect(res.status).toBe(200);
    },
  );

  it.each(["active", "past_due", "archived"])(
    "shows a %s homework's answer to an ungranted TA",
    async (status) => {
      // The grant governs UNRELEASED homeworks only. A TA with no grant at
      // all still grades released work -- that is the whole grader tier.
      getSectionAnswerMock.mockReset().mockResolvedValue(answerWithStatus(status));
      const res = await request(
        fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "ta" })] }),
      );
      expect(res.status).toBe(200);
    },
  );

  it("never withholds from an instructor, who holds every capability implicitly", async () => {
    getSectionAnswerMock.mockReset().mockResolvedValue(answerWithStatus("draft"));
    const res = await request(
      fakeAuthContext({
        memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })],
      }),
    );
    expect(res.status).toBe(200);
  });
});
