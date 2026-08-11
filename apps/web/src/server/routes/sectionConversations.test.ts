import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  startSectionConversationHandler,
  getActiveSectionConversationHandler,
  getSectionConversationHandler,
  restartSectionConversationHandler,
} from "./sectionConversations";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";
import { fakeAuthContext, fakeMembership } from "../testing/authContext";

const TEST_ENV = { DATABASE_URL: "ignored" } as Env;
const COURSE = "course-a";
const SECTION = "11111111-2222-4333-8444-555555555555";
const CONV = "22222222-3333-4444-8555-666666666666";

const startMock = vi.fn();
const restartMock = vi.fn();
const getByIdMock = vi.fn();
const getActiveMock = vi.fn();
const getMessagesMock = vi.fn();
const getOrgScopesForUserMock = vi.fn();

// The access predicates are NOT mocked -- they are the rule under test at
// this layer, and stubbing them would let a route wire them backwards while
// the suite stayed green. Their own table test lives in
// repositories/sectionConversations.access.test.ts.
vi.mock("../repositories/sectionConversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/sectionConversations")>();
  return {
    ...actual,
    startSectionConversation: (...a: unknown[]) => startMock(...a),
    restartSectionConversation: (...a: unknown[]) => restartMock(...a),
    getSectionConversationById: (...a: unknown[]) => getByIdMock(...a),
    getActiveSectionConversation: (...a: unknown[]) => getActiveMock(...a),
    getSectionConversationMessages: (...a: unknown[]) => getMessagesMock(...a),
  };
});
vi.mock("../repositories/users", () => ({
  getOrgScopesForUser: (...a: unknown[]) => getOrgScopesForUserMock(...a),
}));
vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.post("/api/courses/:courseId/sections/:sectionId/conversations", (c) =>
    startSectionConversationHandler(c),
  );
  app.get("/api/courses/:courseId/sections/:sectionId/conversation", (c) =>
    getActiveSectionConversationHandler(c),
  );
  app.get("/api/courses/:courseId/conversations/:conversationId", (c) =>
    getSectionConversationHandler(c),
  );
  app.post("/api/courses/:courseId/conversations/:conversationId/restart", (c) =>
    restartSectionConversationHandler(c),
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

beforeEach(() => {
  startMock.mockReset();
  restartMock.mockReset();
  getByIdMock.mockReset();
  getActiveMock.mockReset();
  getMessagesMock.mockReset().mockResolvedValue([]);
  getOrgScopesForUserMock.mockReset().mockResolvedValue(["org-1"]);
});

describe("POST /api/courses/:courseId/sections/:sectionId/conversations", () => {
  it("denies a non-member with 403", async () => {
    const res = await buildApp(fakeAuthContext({ memberships: [] })).request(
      `/api/courses/${COURSE}/sections/${SECTION}/conversations`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(403);
    expect(startMock).not.toHaveBeenCalled();
  });

  it.each(["not-a-uuid", "1", "'; SELECT 1; --"])(
    "returns 404, never 503, for sectionId %j",
    async (bad) => {
      const res = await buildApp(student()).request(
        `/api/courses/${COURSE}/sections/${encodeURIComponent(bad)}/conversations`,
        { method: "POST" },
        TEST_ENV,
      );
      expect(res.status).toBe(404);
      expect(startMock).not.toHaveBeenCalled();
    },
  );

  it("creates the conversation and returns 201", async () => {
    startMock.mockResolvedValue({ id: CONV, title: "Section 1: A", greetingMessageId: "m-1" });
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/sections/${SECTION}/conversations`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: CONV, title: "Section 1: A", greetingMessageId: "m-1" });
  });

  it("marks a student's conversation as not a teacher test", async () => {
    startMock.mockResolvedValue({ id: CONV, title: "t", greetingMessageId: "m-1" });
    await buildApp(student()).request(
      `/api/courses/${COURSE}/sections/${SECTION}/conversations`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(startMock.mock.calls[0]![2]).toMatchObject({ isTeacherTest: false });
  });

  it("marks an instructor's conversation as a teacher test", async () => {
    startMock.mockResolvedValue({ id: CONV, title: "t", greetingMessageId: "m-1" });
    await buildApp(instructor()).request(
      `/api/courses/${COURSE}/sections/${SECTION}/conversations`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(startMock.mock.calls[0]![2]).toMatchObject({ isTeacherTest: true });
  });

  it("returns 409 when one already exists", async () => {
    const { SectionConversationExistsError } = await import(
      "../repositories/sectionConversations"
    );
    startMock.mockRejectedValue(new SectionConversationExistsError());
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/sections/${SECTION}/conversations`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(409);
  });
});

describe("GET /api/courses/:courseId/sections/:sectionId/conversation", () => {
  it("returns a null conversation rather than 404 when none has been started", async () => {
    getActiveMock.mockResolvedValue(undefined);
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/sections/${SECTION}/conversation`,
      {},
      TEST_ENV,
    );
    // "Not started yet" is an ordinary state the client renders as a start
    // affordance -- not an error.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversation: null, messages: [] });
  });
});

describe("GET /api/courses/:courseId/conversations/:conversationId — access matrix (#27)", () => {
  const conversationOwnedBy = (ownerUserId: string, isTeacherTest = false) => ({
    id: CONV,
    ownerUserId,
    courseId: COURSE,
    sectionId: SECTION,
    title: "t",
    isTeacherTest,
    isDeleted: false,
    createdAt: new Date(),
  });

  it("lets the owner read their own", async () => {
    getByIdMock.mockResolvedValue(conversationOwnedBy("student-1"));
    const res = await buildApp(student("student-1")).request(
      `/api/courses/${COURSE}/conversations/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("hides another student's conversation from a student", async () => {
    getByIdMock.mockResolvedValue(conversationOwnedBy("student-2"));
    const res = await buildApp(student("student-1")).request(
      `/api/courses/${COURSE}/conversations/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });

  it("lets an instructor read a student's conversation", async () => {
    getByIdMock.mockResolvedValue(conversationOwnedBy("student-1"));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/conversations/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });

  it("hides another instructor's test conversation from an instructor", async () => {
    getByIdMock.mockResolvedValue(conversationOwnedBy("instructor-2", true));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/conversations/${CONV}`,
      {},
      TEST_ENV,
    );
    // 404, not 403: a private test conversation must not confirm it exists.
    expect(res.status).toBe(404);
  });

  it("still lets an instructor read their own test conversation", async () => {
    getByIdMock.mockResolvedValue(conversationOwnedBy("instructor-1", true));
    const res = await buildApp(instructor("instructor-1")).request(
      `/api/courses/${COURSE}/conversations/${CONV}`,
      {},
      TEST_ENV,
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/courses/:courseId/conversations/:conversationId/restart", () => {
  it.each(["not-a-uuid", "%00"])("returns 404, never 503, for conversationId %j", async (bad) => {
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/conversations/${encodeURIComponent(bad)}/restart`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
    expect(restartMock).not.toHaveBeenCalled();
  });

  it("returns 201 with the replacement conversation", async () => {
    const submittedAt = new Date();
    restartMock.mockResolvedValue({
      voidedSubmission: { id: "sub-1", submittedAt },
      conversation: { id: "new-conv", title: "Section 1: A", greetingMessageId: "m-2" },
    });
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/conversations/${CONV}/restart`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      conversation: { id: "new-conv", title: "Section 1: A", greetingMessageId: "m-2" },
      voidedSubmission: { id: "sub-1", submittedAt: submittedAt.toISOString() },
    });
  });

  it("returns 409 when the submission has been graded", async () => {
    const { SubmissionGradedError } = await import("../repositories/submissions");
    restartMock.mockRejectedValue(new SubmissionGradedError());
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/conversations/${CONV}/restart`,
      { method: "POST" },
      TEST_ENV,
    );
    // 409, not 404: the student owns it, and "already graded" is something
    // they can act on -- unlike the deliberately opaque 404s below.
    expect(res.status).toBe(409);
  });

  it("collapses not-found and not-owned into one 404", async () => {
    restartMock.mockRejectedValue(new Error("Conversation is not owned by requester"));
    const res = await buildApp(student()).request(
      `/api/courses/${COURSE}/conversations/${CONV}/restart`,
      { method: "POST" },
      TEST_ENV,
    );
    expect(res.status).toBe(404);
  });
});
