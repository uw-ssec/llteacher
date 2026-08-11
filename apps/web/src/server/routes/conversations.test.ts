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
const getConversationByIdMock = vi.fn();
const getMessagesForConversationMock = vi.fn();
vi.mock("../repositories/conversations", () => ({
  listConversationsForOwner: (...args: unknown[]) => listConversationsForOwnerMock(...args),
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  updateConversationTitle: (...args: unknown[]) => updateConversationTitleMock(...args),
  softDeleteConversation: (...args: unknown[]) => softDeleteConversationMock(...args),
  getConversationById: (...args: unknown[]) => getConversationByIdMock(...args),
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

beforeEach(() => {
  listConversationsForOwnerMock.mockReset();
  createConversationMock.mockReset();
  updateConversationTitleMock.mockReset();
  softDeleteConversationMock.mockReset();
  getConversationByIdMock.mockReset();
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

  it("defaults kind to 'tutor' and lists only the caller's conversations for the course", async () => {
    listConversationsForOwnerMock.mockResolvedValue([{ id: "conv-1", title: "Chat 1" }]);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-a");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "conv-1", title: "Chat 1" }]);
    expect(listConversationsForOwnerMock).toHaveBeenCalledWith(
      expect.anything(),
      "course-a",
      "u1",
      { kind: "tutor" },
    );
  });

  it("passes an explicit kind=tutor through", async () => {
    listConversationsForOwnerMock.mockResolvedValue([]);
    await request(buildApp(fakeAuthContext()), "/api/conversations?courseId=course-a&kind=tutor");
    expect(listConversationsForOwnerMock).toHaveBeenCalledWith(
      expect.anything(),
      "course-a",
      "u1",
      { kind: "tutor" },
    );
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

  it("creates a tutor conversation with the default title when title is omitted, and returns 201", async () => {
    const authContext = fakeAuthContext({
      memberships: [{ id: "m1", userId: "u1", courseId: "11111111-1111-1111-1111-111111111111", role: "student" }] as AuthContext["memberships"],
    });
    createConversationMock.mockResolvedValue({ id: "conv-1", title: "New Conversation" });

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
  });

  it("creates a tutor conversation using the supplied title", async () => {
    const authContext = fakeAuthContext({
      memberships: [{ id: "m1", userId: "u1", courseId: "11111111-1111-1111-1111-111111111111", role: "student" }] as AuthContext["memberships"],
    });
    createConversationMock.mockResolvedValue({ id: "conv-1", title: "My chat" });

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
      memberships: [{ id: "m1", userId: "u1", courseId: "11111111-1111-1111-1111-111111111111", role: "student" }] as AuthContext["memberships"],
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
      memberships: [{ id: "m1", userId: "u1", courseId: "11111111-1111-1111-1111-111111111111", role: "student" }] as AuthContext["memberships"],
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
    expect(getConversationByIdMock).not.toHaveBeenCalled();
  });

  it("404s when the conversation does not exist", async () => {
    getConversationByIdMock.mockResolvedValue(null);
    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "New title" });
    expect(res.status).toBe(404);
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("404s (not 403) when the conversation is owned by a different user", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "someone-else", courseId: "course-a" });
    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "New title" });
    expect(res.status).toBe(404);
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("400s when title is empty after trimming whitespace", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "   " });
    expect(res.status).toBe(400);
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("400s when title exceeds 100 chars", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("400s when the request body is not valid JSON", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", {
      method: "PATCH",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("trims the title before persisting and returns the updated row", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    updateConversationTitleMock.mockResolvedValue({ id: "conv-1", title: "Trimmed" });

    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "  Trimmed  " });

    expect(res.status).toBe(200);
    expect(updateConversationTitleMock).toHaveBeenCalledWith(expect.anything(), "course-a", "conv-1", "Trimmed");
    expect(await res.json()).toEqual({ id: "conv-1", title: "Trimmed" });
  });

  it("404s when updateConversationTitle finds nothing to update (e.g. concurrently soft-deleted)", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    updateConversationTitleMock.mockResolvedValue(null);

    const res = await patchConv(buildApp(fakeAuthContext()), "conv-1", { title: "New title" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/conversations/:id", () => {
  it("returns 401 when there is no authContext", async () => {
    const res = await request(buildApp(undefined), "/api/conversations/conv-1", { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(getConversationByIdMock).not.toHaveBeenCalled();
  });

  it("404s when the conversation does not exist", async () => {
    getConversationByIdMock.mockResolvedValue(null);
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(softDeleteConversationMock).not.toHaveBeenCalled();
  });

  it("404s (not 403) when the conversation is owned by a different user", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "someone-else", courseId: "course-a" });
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(softDeleteConversationMock).not.toHaveBeenCalled();
  });

  it("soft-deletes and returns 204 with no body when owned by the caller", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    softDeleteConversationMock.mockResolvedValue(undefined);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", { method: "DELETE" });

    expect(res.status).toBe(204);
    const text = await res.text();
    expect(text).toBe("");
    expect(softDeleteConversationMock).toHaveBeenCalledWith(expect.anything(), "course-a", "conv-1");
  });

  // PR-1 whole-branch review (Important): getOwnedConversationOrNull now
  // checks isDeleted (previously only updateConversationTitle's/
  // getMessagesForConversation's own queries did), so a second DELETE of
  // an already soft-deleted, caller-owned conversation 404s -- idempotent
  // in the "the resource is gone" sense, not "returns 204 again as if the
  // delete just happened".
  it("404s (not 204 again) when the conversation is already soft-deleted", async () => {
    getConversationByIdMock.mockResolvedValue({
      id: "conv-1",
      ownerUserId: "u1",
      courseId: "course-a",
      isDeleted: true,
    });

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(softDeleteConversationMock).not.toHaveBeenCalled();
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
    expect(getConversationByIdMock).not.toHaveBeenCalled();
  });

  it("404s when the conversation does not exist", async () => {
    getConversationByIdMock.mockResolvedValue(null);
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");
    expect(res.status).toBe(404);
    expect(getMessagesForConversationMock).not.toHaveBeenCalled();
  });

  it("404s (not 403) when the conversation is owned by a different user", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "someone-else", courseId: "course-a" });
    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");
    expect(res.status).toBe(404);
    expect(getMessagesForConversationMock).not.toHaveBeenCalled();
  });

  it("returns the conversation's messages mapped to {id, role, parts}, scoped by the conversation's own courseId", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getMessagesForConversationMock.mockResolvedValue([
      { id: "m1", conversationId: "conv-1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: new Date() },
      { id: "m2", conversationId: "conv-1", role: "assistant", parts: [{ type: "text", text: "hello" }], createdAt: new Date() },
    ]);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");

    expect(res.status).toBe(200);
    expect(getMessagesForConversationMock).toHaveBeenCalledWith(expect.anything(), "course-a", "conv-1");
    expect(await res.json()).toEqual([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("returns an empty array (200), not 404, for a conversation with no messages yet", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getMessagesForConversationMock.mockResolvedValue([]);

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // PR-1 whole-branch review (Important): before this fix,
  // getOwnedConversationOrNull didn't check isDeleted at all -- only
  // getMessagesForConversation's own query did, and that only affects which
  // MESSAGE ROWS come back, not whether the conversation itself is treated
  // as found. So a soft-deleted (but owned) conversation's id returned 200
  // [] here -- indistinguishable from "a real, non-deleted conversation
  // with zero messages" -- while PATCH/DELETE on the identical row already
  // correctly 404'd. Same conversation row, three handlers, one shared
  // helper: they must agree.
  it("404s (not 200 []) when the conversation is owned by the caller but soft-deleted", async () => {
    getConversationByIdMock.mockResolvedValue({
      id: "conv-1",
      ownerUserId: "u1",
      courseId: "course-a",
      isDeleted: true,
    });

    const res = await request(buildApp(fakeAuthContext()), "/api/conversations/conv-1/messages");

    expect(res.status).toBe(404);
    expect(getMessagesForConversationMock).not.toHaveBeenCalled();
  });
});
