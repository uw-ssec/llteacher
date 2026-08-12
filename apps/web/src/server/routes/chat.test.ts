import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { chatHandler } from "./chat";
import type { AuthContext } from "../middleware/roles";
import { fakeAuthContext as buildFakeAuthContext, fakeMembership } from "../testing/authContext";
import {
  SectionConversationExistsError,
  SectionNotFoundError,
  SectionNotInteractiveError,
} from "../repositories/sectionConversations";
import type { AppEnv } from "../context";

// Route test (mock db, mock the repository layer, mock streamText) -- per
// the issue's own "Testing Strategy". None of these tests exercise real SQL
// or a real model call; they only verify chatHandler's own persistence,
// ownership, and idempotency logic.
const TEST_ENV = { DATABASE_URL: "ignored", OPENROUTER_API_KEY: "test-key" } as Env;

vi.mock("../../db/client", () => ({ makeDb: () => ({}) }));

const getOwnedConversationOrNullMock = vi.fn();
const createConversationMock = vi.fn();
const appendMessageMock = vi.fn();
const getLastMessagesMock = vi.fn();
const countRecentUserMessagesForUserMock = vi.fn();
vi.mock("../repositories/conversations", () => ({
  getOwnedConversationOrNull: (...args: unknown[]) => getOwnedConversationOrNullMock(...args),
  createConversation: (...args: unknown[]) => createConversationMock(...args),
  appendMessage: (...args: unknown[]) => appendMessageMock(...args),
  getLastMessages: (...args: unknown[]) => getLastMessagesMock(...args),
  countRecentUserMessagesForUser: (...args: unknown[]) => countRecentUserMessagesForUserMock(...args),
}));

// #259: kind:"section" now goes through #27's own lifecycle, not
// createConversation -- mock that module too, and keep the error classes
// real (imported from actual) so chat.ts's `instanceof` checks still work.
const startSectionConversationMock = vi.fn();
const getActiveSectionConversationMock = vi.fn();
vi.mock("../repositories/sectionConversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/sectionConversations")>();
  return {
    ...actual,
    startSectionConversation: (...args: unknown[]) => startSectionConversationMock(...args),
    getActiveSectionConversation: (...args: unknown[]) => getActiveSectionConversationMock(...args),
  };
});

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
  app.post("/api/chat", (c) => chatHandler(c));
  return app;
}

const userUiMessage = { id: "client-1", role: "user", parts: [{ type: "text", text: "hi there" }] };

function postChat(
  app: Hono<AppEnv>,
  payload: { messages: unknown[]; conversationId?: string; courseId?: string; kind?: string; sectionId?: string },
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
    getOwnedConversationOrNullMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getLastMessagesMock.mockReset();
    startSectionConversationMock.mockReset();
    getActiveSectionConversationMock.mockReset();
    streamTextMock.mockClear();
    capturedOnFinish = undefined;
    // #219: under the rate limit by default -- individual rate-limit tests
    // override this.
    countRecentUserMessagesForUserMock.mockReset().mockResolvedValue(0);
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

  it("400s when the last message has no id (pre-#213 clients)", async () => {
    const res = await postChat(buildApp(fakeAuthContext()), {
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    });
    expect(res.status).toBe(400);
  });

  describe("#219 rate limiting", () => {
    it("429s with Retry-After when the caller is over the per-minute budget, without touching the model", async () => {
      countRecentUserMessagesForUserMock.mockResolvedValue(20);

      const res = await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(streamTextMock).not.toHaveBeenCalled();
    });

    it("proceeds normally when under budget", async () => {
      countRecentUserMessagesForUserMock.mockResolvedValue(19);
      createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      getLastMessagesMock.mockResolvedValue([]);

      const res = await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

      expect(res.status).toBe(200);
    });
  });

  describe("new conversations (#214/#231)", () => {
    it("creates a new tutor conversation, auto-titled from the first message, when conversationId is omitted", async () => {
      createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      getLastMessagesMock.mockResolvedValue([]);

      const res = await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

      expect(res.status).toBe(200);
      expect(createConversationMock).toHaveBeenCalledTimes(1);
      const [, , input] = createConversationMock.mock.calls[0]!;
      expect(input).toEqual({
        ownerUserId: "u1",
        sectionId: null,
        kind: "tutor",
        title: "hi there",
      });
    });

    it("truncates a long first message to derive the title", async () => {
      createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      getLastMessagesMock.mockResolvedValue([]);
      const longText = "a".repeat(80);

      await postChat(buildApp(fakeAuthContext()), {
        messages: [{ id: "client-1", role: "user", parts: [{ type: "text", text: longText }] }],
      });

      const [, , input] = createConversationMock.mock.calls[0]!;
      expect(input.title).toBe(`${"a".repeat(60)}…`);
    });

    it("falls back to 'New Conversation' when the first message has no text part", async () => {
      createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      getLastMessagesMock.mockResolvedValue([]);

      await postChat(buildApp(fakeAuthContext()), {
        messages: [{ id: "client-1", role: "user", parts: [{ type: "custom-thing" }] }],
      });

      const [, , input] = createConversationMock.mock.calls[0]!;
      expect(input.title).toBe("New Conversation");
    });

    it("falls back to the caller's own course membership when courseId is omitted", async () => {
      createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      getLastMessagesMock.mockResolvedValue([]);

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

    it("#259: routes kind:'section' through startSectionConversation (#27's lifecycle), not createConversation", async () => {
      startSectionConversationMock.mockResolvedValue({ id: "conv-1" });
      getLastMessagesMock.mockResolvedValue([]);

      const res = await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        kind: "section",
        sectionId: "11111111-1111-1111-1111-111111111111",
      });

      expect(res.status).toBe(200);
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(startSectionConversationMock).toHaveBeenCalledTimes(1);
      const [, , input] = startSectionConversationMock.mock.calls[0]!;
      expect(input).toEqual({
        sectionId: "11111111-1111-1111-1111-111111111111",
        ownerUserId: "u1",
        // #237/#259: derived from the caller's actual course role via the
        // shared isStudentInCourse, not duplicated route-local logic.
        // fakeAuthContext's default membership is a "student" of course-a.
        isTeacherTest: false,
      });
    });

    it("#259: derives isTeacherTest=true for a non-student course role", async () => {
      startSectionConversationMock.mockResolvedValue({ id: "conv-1" });
      getLastMessagesMock.mockResolvedValue([]);

      await postChat(
        buildApp(fakeAuthContext({ memberships: [fakeMembership({ courseId: "course-a", role: "instructor" })] })),
        {
          messages: [userUiMessage],
          kind: "section",
          sectionId: "11111111-1111-1111-1111-111111111111",
        },
      );

      const [, , input] = startSectionConversationMock.mock.calls[0]!;
      expect(input.isTeacherTest).toBe(true);
    });

    it("#259: falls back to the winning conversation on a SectionConversationExistsError race", async () => {
      startSectionConversationMock.mockRejectedValue(new SectionConversationExistsError());
      getActiveSectionConversationMock.mockResolvedValue({
        id: "conv-existing",
        ownerUserId: "u1",
        courseId: "course-a",
      });
      getLastMessagesMock.mockResolvedValue([]);

      const res = await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        kind: "section",
        sectionId: "11111111-1111-1111-1111-111111111111",
      });

      expect(res.status).toBe(200);
      expect(appendMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "conv-existing",
        expect.anything(),
      );
    });

    it("#259: 404s when the section doesn't exist or isn't in the caller's course", async () => {
      startSectionConversationMock.mockRejectedValue(new SectionNotFoundError("not found"));

      const res = await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        kind: "section",
        sectionId: "11111111-1111-1111-1111-111111111111",
      });

      expect(res.status).toBe(404);
    });

    it("#259: 409s when the section is non_interactive", async () => {
      startSectionConversationMock.mockRejectedValue(new SectionNotInteractiveError());

      const res = await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        kind: "section",
        sectionId: "11111111-1111-1111-1111-111111111111",
      });

      expect(res.status).toBe(409);
    });

    it("400s when kind is 'section' but sectionId is missing", async () => {
      const res = await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        kind: "section",
      });
      expect(res.status).toBe(400);
      expect(createConversationMock).not.toHaveBeenCalled();
      expect(startSectionConversationMock).not.toHaveBeenCalled();
    });
  });

  it("persists the inbound user message (with its clientMessageId) before the model call", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessagesMock.mockResolvedValue([]);

    await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "conv-1",
      { role: "user", parts: userUiMessage.parts, clientMessageId: "client-1" },
    );
    // Persisted before streamText is invoked -- the model call must not be
    // able to race ahead of the DB write it depends on being durable.
    const userWriteOrder = appendMessageMock.mock.invocationCallOrder[0]!;
    const streamCallOrder = streamTextMock.mock.invocationCallOrder[0]!;
    expect(userWriteOrder).toBeLessThan(streamCallOrder);
  });

  it("returns the conversationId via the x-conversation-id response header", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessagesMock.mockResolvedValue([]);

    const res = await postChat(buildApp(fakeAuthContext()), { messages: [userUiMessage] });

    expect(res.headers.get("x-conversation-id")).toBe("conv-1");
  });

  it("uses an existing conversationId instead of creating a new one, when owned by the caller", async () => {
    getOwnedConversationOrNullMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessagesMock.mockResolvedValue([]);

    const res = await postChat(buildApp(fakeAuthContext()), {
      messages: [userUiMessage],
      conversationId: "conv-1",
    });

    expect(res.status).toBe(200);
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(res.headers.get("x-conversation-id")).toBe("conv-1");
  });

  // #217/#222: getOwnedConversationOrNull collapses "doesn't exist", "exists
  // but isn't yours", and "exists, is yours, but soft-deleted" into null --
  // chatHandler must turn that into a uniform 404 in every case, never a
  // 401/403 that would let a caller distinguish them.
  describe("#217/#222 conversationId ownership -- uniform 404", () => {
    it("404s when conversationId does not exist, is not owned, or is soft-deleted", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue(null);

      const res = await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        conversationId: "missing-or-not-owned-or-deleted",
      });

      expect(res.status).toBe(404);
      expect(appendMessageMock).not.toHaveBeenCalled();
      expect(streamTextMock).not.toHaveBeenCalled();
    });

    it("passes the caller's userId to getOwnedConversationOrNull, not just the raw conversationId", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue(null);

      await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        conversationId: "conv-1",
      });

      expect(getOwnedConversationOrNullMock).toHaveBeenCalledWith(expect.anything(), "conv-1", "u1");
    });
  });

  describe("#213 idempotency keyed on clientMessageId, not content", () => {
    it("does not double-write the user message on a retry before it was answered (same clientMessageId)", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      // Last row already in the conversation is this exact user message
      // (persisted by a request that never got its response back to the
      // client), and the client is now retrying with the SAME clientMessageId.
      getLastMessagesMock.mockResolvedValue([
        { role: "user", parts: userUiMessage.parts, clientMessageId: "client-1" },
      ]);

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
      expect(streamTextMock).toHaveBeenCalledTimes(1);
    });

    it("persists a genuinely repeated message (identical text, new id) as a new row and a new model call (FUN-001)", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      // Last row is the SAME text ("hi there") but a DIFFERENT clientMessageId
      // -- a student legitimately sending the same reply twice in a row
      // (e.g. "yes", "ok"), not a transport retry of the same send.
      getLastMessagesMock.mockResolvedValue([
        { role: "user", parts: userUiMessage.parts, clientMessageId: "client-0-a-different-send" },
      ]);

      await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        conversationId: "conv-1",
      });

      expect(appendMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "conv-1",
        { role: "user", parts: userUiMessage.parts, clientMessageId: "client-1" },
      );
      expect(streamTextMock).toHaveBeenCalledTimes(1);
    });

    it("still persists a genuinely new user message even when the conversation has prior messages", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      getLastMessagesMock.mockResolvedValue([
        { role: "assistant", parts: [{ type: "text", text: "previous reply" }], clientMessageId: null },
        { role: "user", parts: [{ type: "text", text: "an earlier, different message" }], clientMessageId: "client-0" },
      ]);

      await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        conversationId: "conv-1",
      });

      expect(appendMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "conv-1",
        { role: "user", parts: userUiMessage.parts, clientMessageId: "client-1" },
      );
    });

    it("does not double-write or re-call the model when the assistant already answered this exact turn (same clientMessageId)", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      const persistedAssistantParts = [
        { type: "text", text: "already answered this one" },
        {
          type: "tool-showDefinition",
          toolCallId: "call-1",
          state: "output-available",
          input: { term: "p-value", body: "..." },
          output: { status: "displayed", term: "p-value" },
        },
      ];
      getLastMessagesMock.mockResolvedValue([
        { role: "assistant", parts: persistedAssistantParts, clientMessageId: null },
        { role: "user", parts: userUiMessage.parts, clientMessageId: "client-1" },
      ]);

      const res = await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        conversationId: "conv-1",
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("x-conversation-id")).toBe("conv-1");
      expect(appendMessageMock).not.toHaveBeenCalled();
      expect(streamTextMock).not.toHaveBeenCalled();

      const text = await res.text();
      expect(text).toContain("already answered this one");
      expect(text).toContain('"toolCallId":"call-1"');
      expect(text).toContain('"type":"tool-output-available"');
    });

    it("calls the model again (not a replay) when the persisted assistant row for a DIFFERENT clientMessageId has content", async () => {
      getOwnedConversationOrNullMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
      // Same shape as the "already answered" case, but the persisted user
      // row's clientMessageId does not match this turn's -- must not replay.
      getLastMessagesMock.mockResolvedValue([
        { role: "assistant", parts: [{ type: "text", text: "answer to a different turn" }], clientMessageId: null },
        { role: "user", parts: userUiMessage.parts, clientMessageId: "some-other-send" },
      ]);

      await postChat(buildApp(fakeAuthContext()), {
        messages: [userUiMessage],
        conversationId: "conv-1",
      });

      expect(streamTextMock).toHaveBeenCalledTimes(1);
      expect(appendMessageMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "conv-1",
        { role: "user", parts: userUiMessage.parts, clientMessageId: "client-1" },
      );
    });
  });

  it("persists the streamed assistant message (full text + tool parts) on stream completion", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessagesMock.mockResolvedValue([]);

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
    getLastMessagesMock.mockResolvedValue([]);
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

  // #215
  it("bounds the message array sent to the model to the trailing window on a long conversation", async () => {
    createConversationMock.mockResolvedValue({ id: "conv-1", ownerUserId: "u1", courseId: "course-a" });
    getLastMessagesMock.mockResolvedValue([]);

    const longHistory = Array.from({ length: 60 }, (_, i) => ({
      id: `hist-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `turn ${i}` }],
    }));
    // The schema requires the LAST message to be a well-formed user turn --
    // append the real inbound message on top of the long history.
    await postChat(buildApp(fakeAuthContext()), { messages: [...longHistory, userUiMessage] });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    const callArgs = streamTextMock.mock.calls[0]![0] as { messages: unknown[] };
    // 61 total messages in, bounded to MAX_HISTORY_MESSAGES (40).
    expect(callArgs.messages.length).toBe(40);
  });
});
