// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useTutorConversations } from "./useTutorConversations";

afterEach(() => {
  vi.unstubAllGlobals();
});

const CONV_A = {
  id: "conv-a",
  ownerUserId: "u1",
  courseId: "course-a",
  sectionId: null,
  kind: "tutor" as const,
  title: "Chat A",
  isDeleted: false,
  deletedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  messageCount: 4,
};

describe("useTutorConversations", () => {
  it("fetches GET /api/conversations scoped to the given courseId + kind=tutor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("/api/conversations?courseId=course-a&kind=tutor");
      return new Response(JSON.stringify([CONV_A]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTutorConversations("course-a"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations).toEqual([CONV_A]);
    expect(result.current.loadError).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch and returns an empty, non-error list while courseId is undefined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTutorConversations(undefined));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations).toEqual([]);
    expect(result.current.loadError).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets loadError (not a thrown TypeError) on a non-ok response, matching useStudentHomework's #160 fix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );

    const { result } = renderHook(() => useTutorConversations("course-a"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(true);
    expect(result.current.conversations).toEqual([]);
  });

  it("createConversation POSTs {courseId}, prepends the result with messageCount defaulted to 0, and returns it", async () => {
    const created = {
      id: "conv-new",
      ownerUserId: "u1",
      courseId: "course-a",
      sectionId: null,
      kind: "tutor" as const,
      title: "New Conversation",
      isDeleted: false,
      deletedAt: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    };
    const postCalls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (init?.method === "POST") {
          postCalls.push({ url, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify(created), { status: 201 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    const { result } = renderHook(() => useTutorConversations("course-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned: unknown;
    await act(async () => {
      returned = await result.current.createConversation();
    });

    expect(postCalls).toEqual([{ url: "/api/conversations", body: { courseId: "course-a" } }]);
    expect(returned).toEqual({ ...created, messageCount: 0 });
    expect(result.current.conversations).toEqual([{ ...created, messageCount: 0 }]);
  });

  it("createConversation returns null and leaves the list unchanged on a failed POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ error: "course access denied" }), { status: 403 });
        }
        return new Response(JSON.stringify([CONV_A]), { status: 200 });
      }),
    );

    const { result } = renderHook(() => useTutorConversations("course-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned: unknown = "not-yet-set";
    await act(async () => {
      returned = await result.current.createConversation();
    });

    expect(returned).toBeNull();
    expect(result.current.conversations).toEqual([CONV_A]);
  });

  it("createConversation is a no-op returning null when courseId is undefined", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTutorConversations(undefined));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned: unknown = "not-yet-set";
    await act(async () => {
      returned = await result.current.createConversation();
    });

    expect(returned).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
