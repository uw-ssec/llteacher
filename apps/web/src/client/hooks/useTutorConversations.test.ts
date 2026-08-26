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
      return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTutorConversations("course-a"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.conversations).toEqual([CONV_A]);
    expect(result.current.loadError).toBe(false);
    expect(result.current.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #280: nextCursor !== null surfaced as hasMore -- lets a caller show that
  // the page ceiling is real instead of leaving it silent (load-more itself
  // isn't wired here yet).
  it("sets hasMore when the response carries a non-null nextCursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: "opaque-cursor" }), { status: 200 })),
    );

    const { result } = renderHook(() => useTutorConversations("course-a"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
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
        return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
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
        return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
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

  // #6
  describe("renameConversation", () => {
    it("optimistically updates the title before the PATCH resolves", async () => {
      let resolvePatch!: (res: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        resolvePatch = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (init?.method === "PATCH") return pending;
          expect(url).toBe("/api/conversations?courseId=course-a&kind=tutor");
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );

      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let renamePromise!: Promise<unknown>;
      act(() => {
        renamePromise = result.current.renameConversation("conv-a", "Renamed while in flight");
      });

      await waitFor(() =>
        expect(result.current.conversations[0]!.title).toBe("Renamed while in flight"),
      );

      resolvePatch(
        new Response(JSON.stringify({ ...CONV_A, title: "Renamed while in flight" }), { status: 200 }),
      );
      await act(async () => {
        await renamePromise;
      });
    });

    it("PATCHes /api/conversations/:id with a JSON {title} body, reconciles with the response, and resolves with it", async () => {
      const patchCalls: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          if (init?.method === "PATCH") {
            patchCalls.push({ url, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify({ ...CONV_A, title: "Renamed" }), { status: 200 });
          }
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );

      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let returned: unknown;
      await act(async () => {
        returned = await result.current.renameConversation("conv-a", "Renamed");
      });

      expect(patchCalls).toEqual([
        { url: "/api/conversations/conv-a", body: { title: "Renamed" } },
      ]);
      // messageCount isn't in PATCH's response body -- carried forward
      // from the row being renamed, not defaulted to 0 (unlike a
      // brand-new conversation from createConversation).
      expect(returned).toEqual({ ...CONV_A, title: "Renamed", messageCount: CONV_A.messageCount });
      expect(result.current.conversations[0]).toEqual({
        ...CONV_A,
        title: "Renamed",
        messageCount: CONV_A.messageCount,
      });
    });

    it("reverts the optimistic update and rejects with the server's error message on a failed PATCH", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            return new Response(
              JSON.stringify({ error: "title is required and must be 1-100 chars after trimming" }),
              { status: 400 },
            );
          }
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );

      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.renameConversation("conv-a", "Attempted rename");
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("title is required and must be 1-100 chars after trimming");
      // Reverted -- back to the original title, not left showing the
      // failed attempt.
      expect(result.current.conversations[0]!.title).toBe(CONV_A.title);
    });

    it("rejects with a generic error on a network failure, and reverts the optimistic update", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "PATCH") throw new TypeError("network error");
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );

      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.renameConversation("conv-a", "Attempted rename");
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBeInstanceOf(Error);
      expect(result.current.conversations[0]!.title).toBe(CONV_A.title);
    });

    // #223: renameConversation must not change identity when the
    // conversations list changes for an unrelated reason (e.g. a #216
    // bumpConversation call) -- previously it depended on `conversations`
    // directly, so every list update (including on a completely different
    // row) produced a new renameConversation function, which was the actual
    // cause of TutorConversationsList's effects re-running every render.
    it("keeps the same function identity across a bumpConversation-driven list update", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 })));
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const before = result.current.renameConversation;
      act(() => {
        result.current.bumpConversation("conv-a");
      });
      expect(result.current.conversations[0]!.messageCount).toBe(CONV_A.messageCount + 1);
      expect(result.current.renameConversation).toBe(before);
    });
  });

  // #216
  describe("bumpConversation", () => {
    it("increments messageCount and updates updatedAt for the given conversation", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 })));
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.bumpConversation("conv-a");
      });

      expect(result.current.conversations[0]!.messageCount).toBe(CONV_A.messageCount + 1);
      expect(result.current.conversations[0]!.updatedAt).not.toBe(CONV_A.updatedAt);
    });

    it("re-sorts the bumped conversation to the top, matching the server's updatedAt-desc ordering", async () => {
      const CONV_B = { ...CONV_A, id: "conv-b", title: "Chat B", updatedAt: "2026-08-05T00:00:00.000Z" };
      // CONV_B is more recently updated than CONV_A, so it's returned first
      // (matches listConversationsForOwner's desc(updatedAt) ordering).
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [CONV_B, CONV_A], nextCursor: null }), { status: 200 })),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-b", "conv-a"]);

      act(() => {
        result.current.bumpConversation("conv-a");
      });

      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-a", "conv-b"]);
    });

    it("is a no-op for an id not currently in the list", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 })));
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => {
        result.current.bumpConversation("conv-nonexistent");
      });

      expect(result.current.conversations).toEqual([CONV_A]);
    });
  });

  /* ------------------------------------------------------------------------
     #293 / #310 -- what the hook reports when things are missing or fail.
     ---------------------------------------------------------------------- */
  describe("course context and failure handling (#293, #310)", () => {
    it("reports awaitingCourseContext while there is no courseId to scope a query to", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const { result } = renderHook(() => useTutorConversations(undefined));
      await waitFor(() => expect(result.current.loading).toBe(false));

      // #293: this is the state the rail used to render "No conversations
      // yet" from. The flag is what lets the list tell it apart from a
      // genuinely empty list.
      expect(result.current.awaitingCourseContext).toBe(true);
      expect(result.current.conversations).toEqual([]);
      expect(result.current.loadError).toBe(false);
    });

    it("resolves loading even with no courseId, so a student in no course does not spin forever", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const { result } = renderHook(() => useTutorConversations(undefined));
      // courseId is undefined both while the homework fetch is in flight AND
      // permanently for a student enrolled in nothing -- holding `loading`
      // true to suppress the empty state would never resolve in that second
      // case. The flag above carries that distinction instead.
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.awaitingCourseContext).toBe(true);
    });

    it("clears awaitingCourseContext once a courseId arrives", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 })),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.awaitingCourseContext).toBe(false);
    });

    it("keeps the last known good list when a refresh fails, instead of emptying the rail", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          if (call === 1) {
            return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
          }
          return new Response("boom", { status: 502 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toEqual([CONV_A]));

      // #310: refetch used to setConversations([]) on failure, and refetch
      // only re-runs when courseId changes -- so one 502 during a deploy
      // emptied the rail for the rest of the session and the student's
      // conversations looked deleted.
      act(() => {
        result.current.refetch();
      });
      await waitFor(() => expect(result.current.loadError).toBe(true));
      expect(result.current.conversations).toEqual([CONV_A]);
    });
  });
});
