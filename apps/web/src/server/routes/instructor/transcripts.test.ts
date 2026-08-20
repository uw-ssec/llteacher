import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { listInstructorTranscriptsHandler, getInstructorTranscriptHandler } from "./transcripts";
import type { AuthContext } from "../../middleware/roles";
import type { AppEnv } from "../../context";
import { fakeAuthContext, fakeMembership } from "../../testing/authContext";

const TEST_ENV = {
  DATABASE_URL: "ignored",
  ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  BLIND_INDEX_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
} as Env;

const COURSE = "course-a";
const CONV = "22222222-3333-4444-8555-666666666666";
const SECTION = "11111111-2222-4333-8444-555555555555";

const listMock = vi.fn();
const getDetailMock = vi.fn();
const getMessagesMock = vi.fn();
const getOrgScopeForCourseMock = vi.fn();
const recordTranscriptAccessMock = vi.fn();

// canReadSectionConversation is NOT mocked -- same reasoning as
// routes/sectionConversations.test.ts's own top-of-file comment: it is the
// access rule under test at this layer for the detail route, and stubbing it
// would let this route wire it backwards while the suite stayed green. Its
// own table test lives in repositories/sectionConversations.access.test.ts;
// #246's route-level proof lives in routes/sectionConversations.test.ts.
vi.mock("../../repositories/sectionConversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../repositories/sectionConversations")>();
  return {
    ...actual,
    listInstructorTranscripts: (...a: unknown[]) => listMock(...a),
    getInstructorTranscriptDetail: (...a: unknown[]) => getDetailMock(...a),
    getSectionConversationMessagesFromStart: (...a: unknown[]) => getMessagesMock(...a),
  };
});
vi.mock("../../repositories/organizations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../repositories/organizations")>();
  return { ...actual, getOrgScopeForCourse: (...a: unknown[]) => getOrgScopeForCourseMock(...a) };
});
// recordTranscriptAccess is a real DB write (auditBestEffort ->
// recordAuditEvent) -- mocked here the same way every other repository
// side-effect is mocked in this file, since makeDb is mocked to `{}` below
// and a real insert() call against that would throw. canReadCourseTranscripts
// is deliberately left real (unmocked) -- it drives this file's own 403
// tests and is the transcript-specific composition this task built, not a
// side effect.
vi.mock("../../../lib/instructor-authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/instructor-authz")>();
  return { ...actual, recordTranscriptAccess: (...a: unknown[]) => recordTranscriptAccessMock(...a) };
});
vi.mock("../../../db/client", () => ({ makeDb: () => ({}) }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.onError((_err, c) => c.json({ error: "SERVICE_UNAVAILABLE" }, 503));
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.get("/api/courses/:courseId/instructor/transcripts", (c) => listInstructorTranscriptsHandler(c));
  app.get("/api/courses/:courseId/instructor/transcripts/:conversationId", (c) =>
    getInstructorTranscriptHandler(c),
  );
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

const EMPTY_LIST = { items: [], total: 0 };

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(EMPTY_LIST);
  getDetailMock.mockReset();
  getMessagesMock.mockReset().mockResolvedValue([]);
  getOrgScopeForCourseMock.mockReset().mockResolvedValue("org-1");
  recordTranscriptAccessMock.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/courses/:courseId/instructor/transcripts", () => {
  it("denies a student with 403", async () => {
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/instructor/transcripts`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("denies a grader (TA) of a different course with 403", async () => {
    const res = await buildApp(
      fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-b", role: "ta" })] }),
    ).request(`/api/courses/${COURSE}/instructor/transcripts`, {}, TEST_ENV);
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("allows an instructor of the course, returns 200 with the list", async () => {
    listMock.mockResolvedValue({
      items: [
        {
          conversationId: CONV,
          studentId: "student-1",
          studentName: "Ada Lovelace",
          sectionId: SECTION,
          sectionTitle: "P-values",
          homeworkId: "hw-1",
          homeworkTitle: "HW 1",
          isTeacherTest: false,
          isDeleted: false,
          messageCount: 4,
          lastMessageSnippet: "thanks!",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
      total: 1,
    });
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
  });

  it("#246: allows a TA (grader tier) of the course, returns 200", async () => {
    const res = await buildApp(ta()).request(`/api/courses/${COURSE}/instructor/transcripts`, {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalled();
  });

  it("audits the read via recordTranscriptAccess", async () => {
    await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts`,
      {},
      TEST_ENV,
    );
    expect(recordTranscriptAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ viewerId: "instructor-1", courseId: COURSE, action: "list" }),
    );
  });

  it("passes limit/offset through to the repository (pagination)", async () => {
    await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts?limit=10&offset=20`,
      {},
      TEST_ENV,
    );
    expect(listMock.mock.calls[0]![4]).toMatchObject({ limit: 10, offset: 20 });
  });

  it("defaults limit/offset when not supplied", async () => {
    await buildApp(instructor()).request(`/api/courses/${COURSE}/instructor/transcripts`, {}, TEST_ENV);
    expect(listMock.mock.calls[0]![4]).toMatchObject({ limit: 50, offset: 0 });
  });

  it.each(["0", "201", "not-a-number", "-1"])("rejects an out-of-range limit=%s with 400", async (bad) => {
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts?limit=${bad}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("rejects a negative offset with 400", async () => {
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts?offset=-5`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("passes a valid sectionId/studentId filter through", async () => {
    await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts?sectionId=${SECTION}&studentId=${CONV}`,
      {},
      TEST_ENV,
    );
    expect(listMock.mock.calls[0]![4]).toMatchObject({ sectionId: SECTION, studentId: CONV });
  });

  it("rejects a malformed sectionId filter with 400", async () => {
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts?sectionId=not-a-uuid`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed studentId filter with 400", async () => {
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts?studentId=not-a-uuid`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("lets an unexpected repository failure propagate to a 503, not a routine response", async () => {
    listMock.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(503);
  });
});

describe("GET /api/courses/:courseId/instructor/transcripts/:conversationId — access matrix (#29, #246)", () => {
  const conversationOwnedBy = (ownerUserId: string, isTeacherTest = false, isDeleted = false) => ({
    conversationId: CONV,
    ownerUserId,
    studentName: "A Student",
    sectionId: SECTION,
    sectionTitle: "P-values",
    homeworkId: "hw-1",
    homeworkTitle: "HW 1",
    isTeacherTest,
    isDeleted,
    deletedAt: isDeleted ? new Date("2026-01-03T00:00:00.000Z") : null,
    submission: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  });

  it("denies a student with 403 before any repository call", async () => {
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(getDetailMock).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "1", "'; SELECT 1; --"])(
    "returns 404, never 503, for conversationId %j",
    async (bad) => {
      const res = await buildApp(instructor()).request(
        `/api/courses/${COURSE}/instructor/transcripts/${encodeURIComponent(bad)}`,
        {},
        TEST_ENV,
      );
      expect(res.status).toBe(404);
      expect(getDetailMock).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the conversation doesn't exist in this course scope", async () => {
    getDetailMock.mockResolvedValue(undefined);
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("lets an instructor read a student's conversation", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("student-1"));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("#246: lets a TA read a student's conversation (grader tier)", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("student-1"));
    const res = await buildApp(ta("ta-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("hides another instructor's teacher-test conversation, even though they're a course grader", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("instructor-2", true));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    // 404, not 403 -- must not confirm the private test conversation exists.
    expect(res.status).toBe(404);
  });

  it("hides another grader's teacher-test conversation from a TA", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("instructor-1", true));
    const res = await buildApp(ta("ta-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("still lets an instructor read their own teacher-test conversation", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("instructor-1", true));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("soft-deleted: still readable, flagged isDeleted -- not filtered out (differs from the student-facing list)", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("student-1", false, true));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { isDeleted: boolean; deletedAt: string | null } };
    expect(body.conversation.isDeleted).toBe(true);
    expect(body.conversation.deletedAt).not.toBeNull();
  });

  it("returns messages in the order the repository provides (ascending seq, #283)", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("student-1"));
    getMessagesMock.mockResolvedValue([
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }], createdAt: new Date(), seq: 1 },
      { id: "m2", role: "user", parts: [{ type: "text", text: "hey" }], createdAt: new Date(), seq: 2 },
    ]);
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("sets hasMore when the message page came back full", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("student-1"));
    getMessagesMock.mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => ({
        id: `m${i}`,
        role: "user",
        parts: [{ type: "text", text: String(i) }],
        createdAt: new Date(),
        seq: i,
      })),
    );
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    const body = (await res.json()) as { hasMore: boolean };
    expect(body.hasMore).toBe(true);
  });

  it("audits the read via recordTranscriptAccess with the conversationId", async () => {
    getDetailMock.mockResolvedValue(conversationOwnedBy("student-1"));
    await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(recordTranscriptAccessMock).toHaveBeenCalledWith(
      expect.anything(),
      "org-1",
      expect.objectContaining({ viewerId: "instructor-1", courseId: COURSE, conversationId: CONV, action: "detail" }),
    );
  });

  it("lets an unexpected repository failure propagate to a 503, not a routine 404", async () => {
    getDetailMock.mockRejectedValue(new Error("connection terminated unexpectedly"));
    const res = await buildApp(instructor()).request(
      `/api/courses/${COURSE}/instructor/transcripts/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(503);
  });
});
