import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { conversationsRoutes } from "./conversations";
import type { AuthContext } from "../middleware/roles";
import { fakeAuthContext as buildFakeAuthContext, fakeMembership } from "../testing/authContext";
import type { AppEnv } from "../context";

// Route test (mock db, mock the repository layer) -- per the issue's own
// "Testing Strategy". None of these tests exercise real SQL; they only
// verify the routes' own ownership, validation, and status-code behavior.
const TEST_ENV = { DATABASE_URL: "ignored" } as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const listConversationsForOwnerMock = vi.fn();
const createConversationMock = vi.fn();
const updateConversationTitleMock = vi.fn();
const softDeleteConversationMock = vi.fn();
const getOwnedConversationOrNullMock = vi.fn();
const getMessagesForConversationMock = vi.fn();
vi.mock("../repositories/conversations", () => ({
  listConversationsForOwner: (...args: unknown[]) => listConversationsForOwnerMock(...args),
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  updateConversationTitle: (...args: unknown[]) => updateConversationTitleMock(...args),
  softDeleteConversation: (...args: unknown[]) => softDeleteConversationMock(...args),
  getOwnedConversationOrNull: (...args: unknown[]) => getOwnedConversationOrNullMock(...args),
  getMessagesForConversation: (...args: unknown[]) => getMessagesForConversationMock(...args),
}));

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return buildFakeAuthContext({
    memberships: [fakeMembership({ courseId: "course-a", role: "student" })],
    ...overrides,
  });
}

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.route("/api/conversations", conversationsRoutes);
  return app;
}

function request(app: Hono<AppEnv>, path: string, init?: RequestInit) {
  return app.request(path, init, TEST_ENV);
}

function patchConv(app: Hono<AppEnv>, id: string, body: unknown) {
  return request(app, `/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

// Full raw-row shape every repository mock resolves with -- #218 projects
// this down to ConversationSummary in the route layer, so the projector
// needs real Date objects (not undefined) for createdAt/updatedAt.
function fakeConversationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "conv-1",
    ownerUserId: "u1",
    courseId: "course-a",
    sectionId: null,
    kind: "tutor" as const,
    title: "New Conversation",
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:05:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  listConversationsForOwnerMock.mockReset();
  createConversationMock.mockReset();
  updateConversationTitleMock.mockReset();
  softDeleteConversationMock.mockReset();
  getOwnedConversationOrNullMock.mockReset();
  getMessagesForConversationMock.mockReset();
});

describe("GET /api/conversations", () => {
  it("returns 401 when there is no authContext", async () => {
    const res = await request(buildApp(undefined), "/api/conversations?courseId=course-a");
    expect(res.status).toBe(401);
    expect(listConversationsForOwnerMock).not.toHaveBeenCalled();
  });

  it("400s when courseId is missing", async () => {
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations");
    expect(res.status).toBe(400);
    expect(listConversationsForOwnerMock).not.toHaveBeenCalled();
  });

  it("400s on an unrecognized kind", async () => {
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-a&kind=bogus");
    expect(res.status).toBe(400);
    expect(listConversationsForOwnerMock).not.toHaveBeenCalled();
  });

  it("403s when the caller is not a member of the requested course", async () => {
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-b");
    expect(res.status).toBe(403);
    expect(listConversationsForOwnerMock).not.toHaveBeenCalled();
  });

  it("defaults kind to 'tutor' and lists only the caller's conversations for the course, projected to the wire DTO", async () => {
    listConversationsForOwnerMock.mockResolvedValue([{ ...fakeConversationRow({ title: "Chat 1" }), messageCount: 3 }]);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-a");

    expect(res.status).toBe(200);
    // #218: only the wire fields -- ownerUserId/courseId/sectionId/isDeleted/
    // deletedAt are dropped.
    expect(await res.json()).toEqual([
      {
        id: "conv-1",
        kind: "tutor",
        title: "Chat 1",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:05:00.000Z",
        messageCount: 3,
      },
    ]);
    expect(listConversationsForOwnerMock).toHaveBeenCalledWith(
      expect.anything(),
      "course-a",
      "u1",
      { kind: "tutor", limit: undefined, before: undefined },
    );
  });

  it("passes an explicit kind=tutor through", async () => {
    listConversationsForOwnerMock.mockResolvedValue([]);
    await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-a&kind=tutor");
    expect(listConversationsForOwnerMock).toHaveBeenCalledWith(
      expect.anything(),
      "course-a",
      "u1",
      { kind: "tutor", limit: undefined, before: undefined },
    );
  });

  // #224
  describe("pagination", () => {
    it("passes a valid limit/before through to the repository", async () => {
      listConversationsForOwnerMock.mockResolvedValue([]);
      await request(
        buildApp(fakeAuthContext()),
        "/api/conversations?courseId=course-a&limit=10&before=2026-08-01T00:00:00.000Z",
      );
      const [, , , opts] = listConversationsForOwnerMock.mock.calls[0]!;
      expect(opts.limit).toBe(10);
      expect(opts.before).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    });

    it("400s on a limit outside 1-200", async () => {
      const res = await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-a&limit=0");
      expect(res.status).toBe(400);
      expect(listConversationsForOwnerMock).not.toHaveBeenCalled();
    });

    it("400s on a non-numeric limit", async () => {
      const res = await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-a&limit=abc");
      expect(res.status).toBe(400);
    });

    it("400s on an invalid before timestamp", async () => {
      const res = await request(
        buildApp(fakeAuthContext()),
        "/api/conversations?courseId=course-a&before=not-a-date",
      );
      expect(res.status).toBe(400);
    });
  });
});

describe("POST /api/conversations", () => {
  it("returns 401 when there is no authContext", async () => {
    const res = await request(buildApp(undefined), "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ courseId: "course-a" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("400s when courseId is missing or not a uuid-shaped string", async () => {
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ courseId: "not-a-uuid" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("400s on invalid JSON body", async () => {
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("403s when the caller is not a member of courseId", async () => {
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ courseId: "11111111-1111-1111-1111-111111111111" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("creates a tutor conversation with the default title when title is omitted, and returns 201 with the projected DTO", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "11111111-1111-1111-1111-111111111111", role: "student" })],
    });
    createConversationMock.mockResolvedValue(
      fakeConversationRow({ id: "conv-1", courseId: "11111111-1111-1111-1111-111111111111", title: "New Conversation" }),
    );

    const res = await request(buildApp(authContext), "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ courseId: "11111111-1111-1111-1111-111111111111" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(201);
    expect(createConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      "11111111-1111-1111-1111-111111111111",
      { ownerUserId: "u1", sectionId: null, kind: "tutor", title: "New Conversation" },
    );
    // #218: no ownerUserId/courseId/etc. in the response.
    expect(await res.json()).toEqual({
      id: "conv-1",
      kind: "tutor",
      title: "New Conversation",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:05:00.000Z",
    });
  });

  it("creates a tutor conversation using the supplied title", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "11111111-1111-1111-1111-111111111111", role: "student" })],
    });
    createConversationMock.mockResolvedValue(
      fakeConversationRow({ id: "conv-1", courseId: "11111111-1111-1111-1111-111111111111", title: "My chat" }),
    );

    await request(buildApp(authContext), "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ courseId: "11111111-1111-1111-1111-111111111111", title: "  My chat  " }),
      headers: { "content-type": "application/json" },
    });

    expect(createConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      "11111111-1111-1111-1111-111111111111",
      { ownerUserId: "u1", sectionId: null, kind: "tutor", title: "My chat" },
    );
  });

  it("400s when the supplied title is whitespace-only (empty after trim)", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "11111111-1111-1111-1111-111111111111", role: "student" })],
    });
    const res = await request(buildApp(authContext), "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ courseId: "11111111-1111-1111-1111-111111111111", title: "   " }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("400s when the supplied title is over 100 chars", async () => {
    const authContext = fakeAuthContext({
      memberships: [fakeMembership({ courseId: "11111111-1111-1111-1111-111111111111", role: "student" })],
    });
    const res = await request(buildApp(authContext), "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ courseId: "11111111-1111-1111-1111-111111111111", title: "x".repeat(101) }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(createConversationMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/conversations/:id", () => {
  it("returns 401 when there is no authContext", async () => {
    const res = await patchConv(buildApp(undefined), "conv-1", { title: "New title" });
    expect(res.status).toBe(401);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  // #217: getOwnedConversationOrNull itself collapses "doesn't exist",
  // "not owned", and "soft-deleted" into one null -- these three tests
  // exercise the route's response to that null, not three different repo
  // return shapes (that collapsing is getOwnedConversationOrNull's own
  // responsibility, covered directly in conversations repository tests).
  it("404s when getOwnedConversationOrNull returns null (not found, not owned, or soft-deleted)", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(null);
    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "New title" });
    expect(res.status).toBe(404);
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("passes the caller's userId to getOwnedConversationOrNull", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(null);
    await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "New title" });
    expect(getOwnedConversationOrNullMock).toHaveBeenCalledWith(expect.anything(), "conv-1", "u1");
  });

  it("400s when title is empty after trimming whitespace", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "   " });
    expect(res.status).toBe(400);
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("400s when title exceeds 100 chars", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("400s when the request body is not valid JSON", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", {
      method: "PATCH",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("trims the title before persisting and returns the projected updated row", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    updateConversationTitleMock.mockResolvedValue(fakeConversationRow({ title: "Trimmed" }));

    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "  Trimmed  " });

    expect(res.status).toBe(200);
    expect(updateConversationTitleMock).toHaveBeenCalledWith(expect.anything(), "course-a", "conv-1", "Trimmed");
    expect(await res.json()).toEqual({
      id: "conv-1",
      kind: "tutor",
      title: "Trimmed",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:05:00.000Z",
    });
  });

  it("404s when updateConversationTitle finds nothing to update (e.g. concurrently soft-deleted)", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    updateConversationTitleMock.mockResolvedValue(null);

    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "New title" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/conversations/:id", () => {
  it("returns 401 when there is no authContext", async () => {
    const res = await request(buildApp(undefined), "/api/conversations/conv-1", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  it("404s when getOwnedConversationOrNull returns null", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(null);
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(softDeleteConversationMock).not.toHaveBeenCalled();
  });

  it("soft-deletes and returns 204 with no body when owned by the caller", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    softDeleteConversationMock.mockResolvedValue(undefined);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", { method: "DELETE" });

    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe("");
    expect(softDeleteConversationMock).toHaveBeenCalledWith(expect.anything(), "course-a", "conv-1");
  });
});

// #4 fix-round: added after code review found that selecting an existing
// tutor conversation reset the client's chat to empty with no way to
// reseed it -- not just a visual gap, since chatHandler builds the model's
// context from exactly what the client sends (chat.ts). Ownership tests
// below mirror PATCH/DELETE's 404-not-403 pattern exactly (same
// getOwnedConversationOrNull helper), not a new one.
describe("GET /api/conversations/:id/messages", () => {
  it("returns 401 when there is no authContext", async () => {
    const res = await request(buildApp(undefined), "/api/conversations/conv-1/messages");
    expect(res.status).toBe(401);
    expect(getOwnedConversationOrNullMock).not.toHaveBeenCalled();
  });

  it("404s when getOwnedConversationOrNull returns null (not found, not owned, or soft-deleted)", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(null);
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");
    expect(res.status).toBe(404);
    expect(getMessagesForConversationMock).not.toHaveBeenCalled();
  });

  it("returns the conversation's messages mapped to {id, role, parts}, scoped by the conversation's own courseId", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    getMessagesForConversationMock.mockResolvedValue([
      { id: "m1", conversationId: "conv-1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: new Date(), seq: 1 },
      { id: "m2", conversationId: "conv-1", role: "assistant", parts: [{ type: "text", text: "hello" }], createdAt: new Date(), seq: 2 },
    ]);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");

    expect(res.status).toBe(200);
    expect(getMessagesForConversationMock).toHaveBeenCalledWith(
      expect.anything(),
      "course-a",
      "conv-1",
      { limit: undefined, before: undefined },
    );
    expect(await res.json()).toEqual([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("returns an empty array (200), not 404, for a conversation with no messages yet", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
    getMessagesForConversationMock.mockResolvedValue([]);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // #215
  describe("pagination", () => {
    it("passes a valid limit/before through to the repository", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
      getMessagesForConversationMock.mockResolvedValue([]);
      await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages?limit=50&before=12");
      expect(getMessagesForConversationMock).toHaveBeenCalledWith(
        expect.anything(),
        "course-a",
        "conv-1",
        { limit: 50, before: 12 },
      );
    });

    it("400s on a limit outside 1-500", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
      const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages?limit=0");
      expect(res.status).toBe(400);
      expect(getMessagesForConversationMock).not.toHaveBeenCalled();
    });

    it("400s on a non-integer before", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue(fakeConversationRow());
      const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages?before=abc");
      expect(res.status).toBe(400);
    });
  });
});
