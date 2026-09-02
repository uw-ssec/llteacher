import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { flagResponseHandler, listCourseFeedbackHandler } from "./feedback";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";
import { ResponseAlreadyFlaggedError } from "../repositories/responseFeedback";

// Route test (mocked db, mocked repository layer) -- per the issue's own
// "Testing Strategy". None of these tests exercise real SQL; they verify
// the routes' own ownership/enrollment/validation/status-code behavior.
// Permission-isolation cases that need real join semantics (a student
// flagging a response in a course they're not enrolled in via a stale
// membership row, a dashboard filter actually excluding another course's
// rows at the SQL level) belong in a `.db.test.ts` companion, per this
// repo's convention -- see this task's own report for what is and isn't
// covered here.

// ENCRYPTION_KEY/BLIND_INDEX_KEY: listCourseFeedbackHandler builds a real
// IdentityCipher (loadIdentityCipherKeys) even though listCourseFeedback
// itself is mocked below and never actually decrypts anything -- without
// these, key loading itself throws before the mock is ever reached. Same
// fixture shape as routes/instructor/transcripts.test.ts's own TEST_ENV.
const TEST_ENV = {
  DATABASE_URL: "ignored",
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
} as Env;

const COURSE = "course-a";
const CONV = "22222222-2222-2222-2222-222222222222";
const MSG = "33333333-3333-3333-3333-333333333333";

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const getOwnedConversationOrNullMock = vi.fn();
vi.mock("../repositories/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/conversations")>();
  return { ...actual, getOwnedConversationOrNull: (...a: unknown[]) => getOwnedConversationOrNullMock(...a) };
});

// isStudentInCourse is NOT mocked -- it is the enrollment rule under test
// here, same reasoning transcripts.test.ts gives for leaving
// canReadSectionConversation real: stubbing it would let this route wire
// enrollment backwards while the suite stayed green.
const getFlaggableAssistantMessageMock = vi.fn();
const flagResponseMock = vi.fn();
const listCourseFeedbackMock = vi.fn();
vi.mock("../repositories/responseFeedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/responseFeedback")>();
  return {
    ...actual,
    getFlaggableAssistantMessage: (...a: unknown[]) => getFlaggableAssistantMessageMock(...a),
    flagResponse: (...a: unknown[]) => flagResponseMock(...a),
    listCourseFeedback: (...a: unknown[]) => listCourseFeedbackMock(...a),
  };
});

// #90 review, Important #1: listCourseFeedbackHandler now writes a FERPA
// audit event via lib/instructor-authz.ts's recordTranscriptAccess, the
// same hook routes/instructor/transcripts.ts's own list handler uses --
// mocked here exactly the way that file's own test mocks it (makeDb below
// returns `{}`, which a real recordAuditEvent insert() call would throw
// against). getOrgScopeForCourse/canReadCourseTranscripts are left
// otherwise real; only the two functions this route actually calls are
// stubbed.
const getOrgScopeForCourseMock = vi.fn();
vi.mock("../repositories/organizations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/organizations")>();
  return { ...actual, getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a) };
});
const recordTranscriptAccessMock = vi.fn();
vi.mock("../../lib/instructor-authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/instructor-authz")>();
  return { ...actual, recordTranscriptAccess: (...a: unknown[]) => recordTranscriptAccessMock(...a) };
});

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.onError((_err, c) => c.json({ error: "SERVICE_UNAVAILABLE" }, 503));
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.post("/api/conversations/:conversationId/messages/:messageId/feedback", (c) => flagResponseHandler(c));
  app.get("/api/courses/:courseId/instructor/feedback", (c) => listCourseFeedbackHandler(c));
  return app;
}

function student(userId = "student-1") {
  return fakeAuthContext({
    session: { userId } as AuthContext["session"],
    memberships: [fakeMembership({ courseId: COURSE, role: "student", userId })],
  });
}
function instructor(userId = "instructor-1") {
  return fakeAuthContext({
    session: { userId } as AuthContext["session"],
    memberships: [fakeMembership({ courseId: COURSE, role: "instructor", userId })],
  });
}
function ta(userId = "ta-1") {
  return fakeAuthContext({
    session: { userId } as AuthContext["session"],
    memberships: [fakeMembership({ courseId: COURSE, role: "ta", userId })],
  });
}

function fakeConversationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CONV,
    ownerUserId: "student-1",
    courseId: COURSE,
    sectionId: "44444444-4444-4444-4444-444444444444",
    kind: "section" as const,
    title: "Section 1",
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:05:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  getOwnedConversationOrNullMock.mockReset().mockResolvedValue(fakeConversationRow());
  getFlaggableAssistantMessageMock
    .mockReset()
    .mockResolvedValue({ id: MSG, parts: [{ type: "text", text: "the answer is 42" }] });
  flagResponseMock.mockReset().mockResolvedValue({
    id: "flag-1",
    reason: "incorrect",
    comment: null,
    flaggedAt: new Date("2026-08-01T00:10:00.000Z"),
  });
  listCourseFeedbackMock.mockReset().mockResolvedValue({ items: [], total: 0 });
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  recordTranscriptAccessMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/conversations/:conversationId/messages/:messageId/feedback (#90)", () => {
  const body = { reason: "incorrect" as const };

  it("requires auth", async () => {
    const res = await buildApp(undefined).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "1"])("404s on a malformed conversationId %j", async (bad) => {
    const res = await buildApp(student()).request(
      `/api/conversations/${encodeURIComponent(bad)}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  it("404s on a malformed messageId", async () => {
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/not-a-uuid/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid JSON body", async () => {
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "not json" },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("400s on a missing reason", async () => {
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid reason enum value", async () => {
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "not_a_real_reason" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  it("400s on a comment over the length cap", async () => {
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "other", comment: "x".repeat(2001) }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
  });

  it("404s when the conversation doesn't exist, isn't owned, or is soft-deleted (getOwnedConversationOrNull -> null)", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(null);
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(flagResponseMock).not.toHaveBeenCalled();
  });

  it("404s a non-enrolled student's own conversation in a different course than their membership claims", async () => {
    // getOwnedConversationOrNull already enforces isMemberOf, so the only
    // way to reach a mismatched membership here is a caller whose
    // AuthContext has no membership row for the conversation's course at
    // all -- exactly the "student flagging a response in a course they're
    // not in" case the issue's own Testing Strategy names.
    const res = await buildApp(
      fakeAuthContext({
        session: { userId: "student-2" } as AuthContext["session"],
        memberships: [fakeMembership({ courseId: "course-b", role: "student", userId: "student-2" })],
      }),
    ).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("404s an instructor's own teacher-test conversation (not an enrolled student)", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow({ ownerUserId: "instructor-1" }));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(getFlaggableAssistantMessageMock).not.toHaveBeenCalled();
  });

  it("400s a tutor-kind (non-section) conversation", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow({ kind: "tutor", sectionId: null }));
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(getFlaggableAssistantMessageMock).not.toHaveBeenCalled();
  });

  it("404s when the message doesn't exist, belongs to a different conversation, or isn't an assistant turn", async () => {
    getFlaggableAssistantMessageMock.mockResolvedValue(null);
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(flagResponseMock).not.toHaveBeenCalled();
  });

  it("passes conversationId/messageId scoping through to getFlaggableAssistantMessage", async () => {
    await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(getFlaggableAssistantMessageMock).toHaveBeenCalledWith(expect.anything(), CONV, MSG);
  });

  it("201s and stores the message's parts as the responseSnapshot", async () => {
    const res = await buildApp(student("student-1")).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "gave_away_answer", comment: "told me the final number" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(flagResponseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: CONV,
        messageId: MSG,
        studentId: "student-1",
        reason: "gave_away_answer",
        comment: "told me the final number",
        responseSnapshot: [{ type: "text", text: "the answer is 42" }],
      }),
    );
  });

  it("returns 409 with code already_flagged on a duplicate flag", async () => {
    flagResponseMock.mockRejectedValue(new ResponseAlreadyFlaggedError());
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("already_flagged");
  });

  it("lets an unexpected repository failure propagate to a 503, not a routine response", async () => {
    flagResponseMock.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const res = await buildApp(student()).request(
      `/api/conversations/${CONV}/messages/${MSG}/feedback`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      TEST_ENV,
    );
    expect(res.status).toBe(503);
  });
});

describe("GET /api/courses/:courseId/instructor/feedback (#90)", () => {
  it("denies a student with 403", async () => {
    const res = await buildApp(student()).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(listCourseFeedbackMock).not.toHaveBeenCalled();
  });

  it("denies a grader (TA) of a different course with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-b", role: "ta" })] }),
    ).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(listCourseFeedbackMock).not.toHaveBeenCalled();
  });

  it("allows an instructor of the course, returns 200 with the list", async () => {
    listCourseFeedbackMock.mockResolvedValue({
      items: [
        {
          id: "flag-1",
          conversationId: CONV,
          messageId: MSG,
          studentId: "student-1",
          studentName: "Ada Lovelace",
          reason: "confusing",
          comment: null,
          responseSnapshot: [{ type: "text", text: "..." }],
          isDeleted: false,
          sectionId: "section-1",
          sectionTitle: "P-values",
          homeworkId: "hw-1",
          homeworkTitle: "HW 1",
          homeworkStatus: "active",
          flaggedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
      total: 1,
    });
    const res = await buildApp(instructor()).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
  });

  it("#172: allows a TA (grader tier) of the course, returns 200", async () => {
    const res = await buildApp(ta()).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(listCourseFeedbackMock).toHaveBeenCalled();
  });

  // #90 review, Important #1: FERPA -- this read returns decrypted student
  // names and flagged tutor content for a whole course, so it must audit
  // the same way listInstructorTranscriptsHandler's own list read does.
  it("audits the read via recordTranscriptAccess with a feedback-list action", async () => {
    await buildApp(instructor("instructor-1")).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(recordTranscriptAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ viewerId: "instructor-1", courseId: COURSE, action: "feedback-list" }),
    );
  });

  it("filters out a flag on a currently-unreleased homework for a TA without canViewDrafts", async () => {
    listCourseFeedbackMock.mockResolvedValue({
      items: [
        {
          id: "flag-draft",
          conversationId: CONV,
          messageId: MSG,
          studentId: "student-1",
          studentName: "A Student",
          reason: "other",
          comment: null,
          responseSnapshot: [],
          isDeleted: false,
          sectionId: "section-1",
          sectionTitle: "Draft section",
          homeworkId: "hw-draft",
          homeworkTitle: "Draft HW",
          homeworkStatus: "draft",
          flaggedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
      total: 1,
    });
    const res = await buildApp(ta("ta-1")).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("shows an instructor (who always has draft rights) an unreleased-homework flag", async () => {
    listCourseFeedbackMock.mockResolvedValue({
      items: [
        {
          id: "flag-draft",
          conversationId: CONV,
          messageId: MSG,
          studentId: "student-1",
          studentName: "A Student",
          reason: "other",
          comment: null,
          responseSnapshot: [],
          isDeleted: false,
          sectionId: "section-1",
          sectionTitle: "Draft section",
          homeworkId: "hw-draft",
          homeworkTitle: "Draft HW",
          homeworkStatus: "draft",
          flaggedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
      total: 1,
    });
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/feedback`,
      {},
      TEST_ENV,
    );
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it("passes limit/offset through to the repository (pagination)", async () => {
    await buildApp(instructor()).request(`/api/courses/${COURSE}/instructor/feedback?limit=10&offset=20`, {}, TEST_ENV);
    expect(listCourseFeedbackMock.mock.calls[0]![3]).toMatchObject({ limit: 10, offset: 20 });
  });

  it("defaults limit/offset when not supplied", async () => {
    await buildApp(instructor()).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(listCourseFeedbackMock.mock.calls[0]![3]).toMatchObject({ limit: 50, offset: 0 });
  });

  it.each(["0", "201", "not-a-number", "-1"])("rejects an out-of-range limit=%s with 400", async (bad) => {
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/feedback?limit=${bad}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(listCourseFeedbackMock).not.toHaveBeenCalled();
  });

  it("rejects a negative offset with 400", async () => {
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/feedback?offset=-5`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(listCourseFeedbackMock).not.toHaveBeenCalled();
  });

  it("lets an unexpected repository failure propagate to a 503, not a routine response", async () => {
    listCourseFeedbackMock.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const res = await buildApp(instructor()).request(`/api/courses/${COURSE}/instructor/feedback`, {}, TEST_ENV);
    expect(res.status).toBe(503);
  });
});
