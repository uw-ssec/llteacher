import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { chatHandler } from "./chat";
import type { AuthContext } from "../middleware/roles";
import type { AppEnv } from "../context";

// Route test (mock db, mock the repository layer, mock streamText) -- per
// the issue's own "Testing Strategy". None of these tests exercise real SQL
// or a real model call; they only verify chatHandler's own persistence,
// ownership, and idempotency logic.
const TEST_ENV = { DATABASE_URL: "ignored", OPENROUTER_API_KEY: "test-key" } as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const getConversationByIdMock = vi.fn();
const createConversationMock = vi.fn();
const appendMessageMock = vi.fn();
const getLastMessageMock = vi.fn();
vi.mock("../repositories/conversations", () => ({
  getConversationById: (...args: unknown[]) => getConversationByIdMock(...args),
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  appendMessage: (...args: unknown[]) => appendMessageMock(...args),
  getLastMessage: (...args: unknown[]) => getLastMessageMock(...args),
}));

// streamText is mocked so no real model call happens and the test controls
// exactly when/what onFinish receives -- importOriginal keeps
// convertToModelMessages/jsonSchema/stepCountIs (used by chat.ts, untouched
// by #3) running for real.
type FakeResponseMessage = { id?: string; role: string; parts: unknown[] };
let capturedOnFinish: ((event: { responseMessage: FakeResponseMessage }) => void | Promise<void>) | undefined;
const streamTextMock = vi.fn((_args: Record<string, unknown>) => {
  return {
    toUIMessageStreamResponse: (opts?: {
      headers?: Record<string, string>;
      onFinish?: (event: { responseMessage: FakeResponseMessage }) => void | Promise<void>;
    }) => {
      capturedOnFinish = opts?.onFinish;
      return new Response("stream-body", { status: 200, headers: opts?.headers });
    },
  };
});
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: (args: Record<string, unknown>) => streamTextMock(args) };
});

function fakeAuthContext(overrides: Partial<AuthContext> = {}): AuthContext {
  const memberships =
    overrides.memberships ??
    ([{ id: "m1", userId: "u1", courseId: "course-a", role: "student" }] as AuthContext["memberships"]);
  return {
    session: { userId: "u1", workosUserId: "w1", sessionEpoch: 0, issuedAt: 0, expiresAt: 0 },
    memberships,
    hasRole: (role) => memberships.some((m) => m.role === role),
    isMemberOf: (courseId) => memberships.some((m) => m.courseId === courseId),
    isInstructorOf: () => false,
    ...overrides,
  };
}

function buildApp(authContext: AuthContext | undefined) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (authContext) c.set("authContext", authContext);
    await next();
  });
  app.post("/api/chat", (c) => chatHandler(c));
  return app;
}

const userUiMessage = { id: "client-1", role: "user", parts: [{ type: "text", text: "hi there" }] };

function postChat(
  app: Hono<AppEnv>,
  payload: { messages: unknown[]; conversationId?: string; courseId?: string },
) {
  return app.request(
    "/api/chat",
    {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    },
    TEST_ENV,
  );
}

describe("POST /api/chat", () => {
  beforeEach(() => {
    getConversationByIdMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getLastMessageMock.mockReset();
    streamTextMock.mockClear();
    capturedOnFinish = undefined;
  });

  it("returns 401 when there is no authContext", async () => {
    const res = await postChat(buildApp(undefined), { messages: [userUiMessage] });
    expect(res.status).toBe(401);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("returns 500 when OPENROUTER_API_KEY is not set", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("authContext", fakeAuthContext());
      await next();
    });
    app.post("/api/chat", (c) => chatHandler(c));
    const res = await app.request(
      "/api/chat",
      { method: "POST", body: JSON.stringify({ messages: [userUiMessage] }), headers: { "content-type": "application/json" } },
      { DATABASE_URL: "ignored" } as Env,
    );
    expect(res.status).toBe(500);
  });

  it("400s when the last message isn't a well-formed user message", async () => {
    const res = await postChat(buildApp(fakeAuthContext()), {
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "not a user turn" }] }],
    });
    expect(res.status).toBe(400);
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it("creates a new tutor conversation with a default title when conversationId is omitted", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue(null);

    const res = await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

    expect(res.status).toBe(200);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    const [, , input] = createConversationMock.mock.calls[0]!;
    expect(input).toEqual({
      ownerUserId: "u1",
      sectionId: null,
      kind: "tutor",
      title: "New Conversation",
    });
  });

  it("falls back to the caller's own course membership when courseId is omitted", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue(null);

    await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

    // scope.ts's courseScopeFromAuthContext mints a CourseScope only from a
    // courseId the authContext actually reports membership in -- asserting
    // createConversation was called at all (rather than 403ing) is itself
    // proof the fallback resolved to "course-a", the one membership fakeAuthContext sets up.
    expect(createConversationMock).toHaveBeenCalledTimes(1);
  });

  it("403s when the caller has no course membership to fall back to", async () => {
    const res = await postChat(buildApp(fakeAuthContext({ memberships: [] })), { messages: [userUiMessage] });
    expect(res.status).toBe(403);
    expect(createConversationMock).not.toHaveBeenCalled();
  });

  it("persists the inbound user message before the model call", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue(null);

    await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "conv-1",
      { role: "user", parts: userUiMessage.parts },
    );
    // Persisted before streamText is invoked -- the model call must not be
    // able to race ahead of the DB write it depends on being durable.
    const userWriteOrder = appendMessageMock.mock.invocationCallOrder[0]!;
    const streamCallOrder = streamTextMock.mock.invocationCallOrder[0]!;
    expect(userWriteOrder).toBeLessThan(streamCallOrder);
  });

  it("returns the conversationId via the x-conversation-id response header", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue(null);

    const res = await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

    expect(res.headers.get("x-conversation-id")).toBe("conv-1");
  });

  it("uses an existing conversationId instead of creating a new one, when owned by the caller", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue(null);

    const res = await postChat(buildApp(fakeAuthContext()), {
      messages: [userUiMessage],
      conversationId: "conv-1",
    });

    expect(res.status).toBe(200);
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(res.headers.get("x-conversation-id")).toBe("conv-1");
  });

  it("404s when conversationId does not exist", async () => {
    getConversationByIdMock.mockResolvedValue(null);

    const res = await postChat(buildApp(fakeAuthContext()), {
      messages: [userUiMessage],
      conversationId: "missing-conv",
    });

    expect(res.status).toBe(404);
    expect(appendMessageMock).not.toHaveBeenCalled();
  });

  it("401s when conversationId belongs to a different user (ownership check)", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "someone-else", courseId: "course-a" });

    const res = await postChat(buildApp(fakeAuthContext()), {
      messages: [userUiMessage],
      conversationId: "conv-1",
    });

    expect(res.status).toBe(401);
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("does not double-write the user message on a retry (idempotency)", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    // Simulates the disconnect/retry race from the issue's pitfall #1: the
    // last row already in the conversation is this exact user message
    // (persisted by a request that never got its response back to the
    // client), and the client is now retrying with the same message.
    getLastMessageMock.mockResolvedValue({ role: "user", parts: userUiMessage.parts });

    await postChat(buildApp(fakeAuthContext()), {
      messages: [userUiMessage],
      conversationId: "conv-1",
    });

    expect(appendMessageMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "conv-1",
      expect.objectContaining({ role: "user" }),
    );
  });

  it("still persists a genuinely new user message even when the conversation has prior messages", async () => {
    getConversationByIdMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue({ role: "assistant", parts: [{ type: "text", text: "previous reply" }] });

    await postChat(buildApp(fakeAuthContext()), {
      messages: [userUiMessage],
      conversationId: "conv-1",
    });

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "conv-1",
      { role: "user", parts: userUiMessage.parts },
    );
  });

  it("persists the streamed assistant message (full text + tool parts) on stream completion", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue(null);

    await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

    expect(capturedOnFinish).toBeDefined();
    const responseMessage = {
      id: "resp-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Here's a question for you..." },
        { type: "tool-showDefinition", toolCallId: "call-1", state: "output-available", input: { term: "p-value", body: "..." }, output: { status: "displayed", term: "p-value" } },
      ],
    };
    await capturedOnFinish!({ responseMessage });

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "conv-1",
      { role: "assistant", parts: responseMessage.parts },
    );
  });

  it("logs (does not throw) when the assistant persistence write fails inside onFinish", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessageMock.mockResolvedValue(null);
    appendMessageMock.mockImplementation(async (_db, _scope, _id, input) => {
      if (input.role === "assistant") throw new Error("db unavailable");
      return { id: "msg-1" };
    });

    await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });
    expect(capturedOnFinish).toBeDefined();

    await expect(
      capturedOnFinish!({ responseMessage: { id: "resp-1", role: "assistant", parts: [{ type: "text", text: "hi" }] } }),
    ).resolves.not.toThrow();
  });
});
