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

  // #280: nextCursor !== null surfaced as hasMore -- what the rail's
  // load-more affordance renders off.
  it("sets hasMore when the response carries a non-null nextCursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: "opaque-cursor" }), { status: 200 })),
    );

    const { result } = renderHook(() => useTutorConversations("course-a"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
  });

  /* #280 (requirement 2, rail half). The regression this guards: before
     this fix `limit`/`before` appeared ZERO times in the entire client, so
     the route's 50-row default page was a silent hard ceiling -- the
     51st-oldest conversation was unreachable from every UI surface. These
     assert the request actually goes out carrying the SERVER's own opaque
     cursor (not a client-reconstructed one -- that reconstruction, off a
     millisecond-truncated updatedAt, was #281's precision-loss bug), and
     that the second page is APPENDED to the first rather than replacing
     it. */
  describe("loadMore (#280)", () => {
    const CONV_B = { ...CONV_A, id: "conv-b", title: "Chat B" };

    it("requests the next page with the server's nextCursor as `before` and appends it", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("before=")) {
          return new Response(JSON.stringify({ items: [CONV_B], nextCursor: null }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [CONV_A], nextCursor: "cursor-page-1" }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.conversations).toEqual([CONV_A]);
      expect(result.current.hasMore).toBe(true);

      await act(async () => {
        await result.current.loadMore();
      });

      // The exact URL, not just "a second call happened": the cursor has to
      // be the server's own value, echoed back verbatim and URL-encoded.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondUrl = fetchMock.mock.calls[1]![0] as string;
      expect(secondUrl).toBe("/api/conversations?courseId=course-a&kind=tutor&before=cursor-page-1");

      // Appended (older rows below), not replaced.
      expect(result.current.conversations).toEqual([CONV_A, CONV_B]);
      // Last page reached -- the affordance must disappear rather than
      // offer a page that isn't there.
      expect(result.current.hasMore).toBe(false);
    });

    it("is a no-op once the last page has been reached (no cursor to page with)", async () => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.loadMore();
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sets loadMoreError and KEEPS the cursor on a failed page, so retrying is one more click", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("before=")) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ items: [CONV_A], nextCursor: "cursor-page-1" }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.loadMoreError).toBe(true);
      // Page 1 is untouched -- a failed load-more invalidates nothing
      // already on screen.
      expect(result.current.conversations).toEqual([CONV_A]);
      expect(result.current.hasMore).toBe(true);
    });
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

    // #291: "Conversation not found" is updateConversationHandler's own
    // internal vocabulary for its 404 -- it read as a system fault
    // rendered permanently beside a rail title the student just tried to
    // rename themselves. Translated here, the one place this route's
    // error text reaches the student.
    it("translates a 404's server vocabulary into student-facing copy", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "PATCH") {
            return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404 });
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

      expect((caught as Error).message).toBe("This conversation is no longer available.");
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
    // conversations list changes for an unrelated reason (e.g. a #216/#438
    // reconcileConversationCount call) -- previously it depended on
    // `conversations` directly, so every list update (including on a
    // completely different row) produced a new renameConversation function,
    // which was the actual cause of TutorConversationsList's effects
    // re-running every render.
    it("keeps the same function identity across a reconcileConversationCount-driven list update", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/conversations/conv-a") {
            return new Response(JSON.stringify({ ...CONV_A, messageCount: CONV_A.messageCount + 2 }), { status: 200 });
          }
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      const before = result.current.renameConversation;
      await act(async () => {
        await result.current.reconcileConversationCount("conv-a");
      });
      expect(result.current.conversations[0]!.messageCount).toBe(CONV_A.messageCount + 2);
      expect(result.current.renameConversation).toBe(before);
    });
  });

  // #216, #292, #438
  describe("reconcileConversationCount", () => {
    // #438: replaces the old delta-guessing bumpConversation(id, delta) --
    // this fetches GET /api/conversations/:id and sets messageCount/
    // updatedAt directly from whatever that response says, rather than
    // adding a client-computed guess to whatever count was already showing.
    it("GETs /api/conversations/:id and sets messageCount/updatedAt from the response, not a client-computed delta", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/conversations/conv-a") {
          return new Response(
            JSON.stringify({ ...CONV_A, messageCount: 9, updatedAt: "2026-08-09T00:00:00.000Z" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.reconcileConversationCount("conv-a");
      });

      // Not CONV_A.messageCount + anything -- the server's own number,
      // verbatim, which is exactly the point: the server may have persisted
      // only one row for a turn the client's own SSE read would have
      // guessed at two rows for (#438's own motivating gap).
      expect(result.current.conversations[0]!.messageCount).toBe(9);
      expect(result.current.conversations[0]!.updatedAt).toBe("2026-08-09T00:00:00.000Z");
      expect(fetchMock).toHaveBeenCalledWith("/api/conversations/conv-a");
    });

    // #438: a turn that persists no assistant row (chat.ts's persistence
    // gate declines the reply -- unrenderable content, or a finish reason
    // outside its allowlist) still writes the student's own row, so the
    // authoritative count moves by exactly 1, not the 2 a completed-looking
    // stream would have been guessed at under the old delta scheme. This is
    // the requirement's own regression case at the hook level: the rail
    // must agree with the server's real count(*), whatever it is.
    it("leaves the rail agreeing with the server's count(*) when a turn persisted only the student's row", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/conversations/conv-a") {
            // Server persisted only ONE new row for this turn: 4 -> 5, not 6.
            return new Response(JSON.stringify({ ...CONV_A, messageCount: 5 }), { status: 200 });
          }
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.conversations[0]!.messageCount).toBe(4);

      await act(async () => {
        await result.current.reconcileConversationCount("conv-a");
      });

      expect(result.current.conversations[0]!.messageCount).toBe(5);
    });

    it("re-sorts the reconciled conversation to the top, matching the server's updatedAt-desc ordering", async () => {
      const CONV_B = { ...CONV_A, id: "conv-b", title: "Chat B", updatedAt: "2026-08-05T00:00:00.000Z" };
      // CONV_B is more recently updated than CONV_A, so it's returned first
      // (matches listConversationsForOwner's desc(updatedAt) ordering).
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/conversations/conv-a") {
            return new Response(
              JSON.stringify({ ...CONV_A, messageCount: CONV_A.messageCount + 2, updatedAt: "2026-08-06T00:00:00.000Z" }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ items: [CONV_B, CONV_A], nextCursor: null }), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-b", "conv-a"]);

      await act(async () => {
        await result.current.reconcileConversationCount("conv-a");
      });

      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-a", "conv-b"]);
    });

    it("is a no-op for an id not currently in the list", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/conversations/conv-nonexistent") {
            return new Response(JSON.stringify({ ...CONV_A, id: "conv-nonexistent" }), { status: 200 });
          }
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.reconcileConversationCount("conv-nonexistent");
      });

      expect(result.current.conversations).toEqual([CONV_A]);
    });

    // #438: a fetch failure (network error or non-2xx) must not throw into
    // the caller -- trackTutorTurnCompletion invokes this fire-and-forget
    // with nothing to catch a rejection -- and must leave whatever count
    // was already showing untouched rather than corrupting it.
    it("fails silently and leaves the count untouched on a fetch error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === "/api/conversations/conv-a") return new Response("nope", { status: 500 });
          return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await expect(
        act(async () => {
          await result.current.reconcileConversationCount("conv-a");
        }),
      ).resolves.not.toThrow();

      expect(result.current.conversations).toEqual([CONV_A]);
    });
  });

  /* ------------------------------------------------------------------------
     #289: deletion.
     ---------------------------------------------------------------------- */
  describe("deleteConversation (#289)", () => {
    const twoRows = () => ({ items: [CONV_A, { ...CONV_A, id: "conv-b", title: "Chat B" }], nextCursor: null });

    it("removes the row only after the server confirms", async () => {
      let resolveDelete!: (r: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === "DELETE") return new Promise<Response>((r) => (resolveDelete = r));
          return new Response(JSON.stringify(twoRows()), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(2));

      let done!: Promise<boolean>;
      act(() => {
        done = result.current.deleteConversation("conv-a");
      });
      // Not optimistic, deliberately: deletion is the one action here a
      // student cannot undo from the UI, so a row that vanishes and then
      // reappears on the next load is worse than a half-second delay.
      expect(result.current.conversations).toHaveLength(2);

      await act(async () => {
        resolveDelete(new Response(null, { status: 204 }));
        await done;
      });
      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-b"]);
    });

    it("keeps the row and reports failure when the server refuses", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === "DELETE") return new Response("no", { status: 500 });
          return new Response(JSON.stringify(twoRows()), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(2));

      let ok!: boolean;
      await act(async () => {
        ok = await result.current.deleteConversation("conv-a");
      });
      expect(ok).toBe(false);
      expect(result.current.conversations).toHaveLength(2);
    });

    it("treats a 404 as done -- deleted in another tab is still deleted", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === "DELETE") return new Response("gone", { status: 404 });
          return new Response(JSON.stringify(twoRows()), { status: 200 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(2));

      let ok!: boolean;
      await act(async () => {
        ok = await result.current.deleteConversation("conv-a");
      });
      // Keeping the row on screen because someone deleted it elsewhere would
      // be the wrong reading of "failed".
      expect(ok).toBe(true);
      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-b"]);
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

  /* ------------------------------------------------------------------------
     #388: retention must not cross a course boundary.
     ---------------------------------------------------------------------- */
  describe("course-scoped retention (#388)", () => {
    it("drops the previous course's rows on a switch, even before the new fetch resolves", async () => {
      let resolveSecond!: (r: Response) => void;
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          if (call === 1) return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
          return new Promise<Response>((r) => (resolveSecond = r));
        }),
      );
      const { result, rerender } = renderHook(({ id }) => useTutorConversations(id), {
        initialProps: { id: "course-a" },
      });
      await waitFor(() => expect(result.current.conversations).toEqual([CONV_A]));

      rerender({ id: "course-b" });

      // Course A's rows must not be on screen, or selectable, while the UI
      // is scoped to course B.
      expect(result.current.conversations).toEqual([]);
      resolveSecond(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    });

    it("does not retain the previous course's rows when the new course's fetch fails", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          if (call === 1) return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
          return new Response("boom", { status: 502 });
        }),
      );
      const { result, rerender } = renderHook(({ id }) => useTutorConversations(id), {
        initialProps: { id: "course-a" },
      });
      await waitFor(() => expect(result.current.conversations).toEqual([CONV_A]));

      rerender({ id: "course-b" });
      await waitFor(() => expect(result.current.loadError).toBe(true));

      // Rows from another course are not stale, they are wrong -- the
      // "may be out of date" retention rule does not apply across scopes.
      expect(result.current.conversations).toEqual([]);
    });

    it("still retains rows when a refresh of the SAME course fails", async () => {
      let call = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          call += 1;
          if (call === 1) return new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 });
          return new Response("boom", { status: 502 });
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toEqual([CONV_A]));

      act(() => {
        result.current.refetch();
      });
      await waitFor(() => expect(result.current.loadError).toBe(true));

      // #310's original fix must survive #388's narrowing.
      expect(result.current.conversations).toEqual([CONV_A]);
    });
  });

  /* ------------------------------------------------------------------------
     Found by a high-effort re-review of THIS PR's own fixes.
     ---------------------------------------------------------------------- */
  describe("a retry must not revert local mutations", () => {
    it("keeps a conversation created while a retry was in flight", async () => {
      let releaseGet!: (r: Response) => void;
      let getCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            return new Response(
              JSON.stringify({ ...CONV_A, id: "conv-new", title: "Brand new" }),
              { status: 201 },
            );
          }
          getCount += 1;
          if (getCount === 1) return new Response("boom", { status: 502 });
          // The retry: its server snapshot predates the POST below.
          return new Promise<Response>((r) => (releaseGet = r));
        }),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.loadError).toBe(true));

      // Try again -- the New conversation button stays enabled meanwhile.
      act(() => {
        result.current.refetch();
      });
      await act(async () => {
        await result.current.createConversation();
      });
      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-new"]);

      // Now the retry lands with a snapshot taken BEFORE the create.
      await act(async () => {
        releaseGet(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
        await new Promise((r) => setTimeout(r, 0));
      });

      // Replacing the list wholesale would delete the row the student just
      // watched appear.
      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-new"]);
    });

    it("still accepts a response when nothing changed locally", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ items: [CONV_A], nextCursor: null }), { status: 200 })),
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toEqual([CONV_A]));
    });
  });

  /* ------------------------------------------------------------------------
     #310, #438: reconciliation ordering. Each test here routes fetch by
     URL: the initial `?courseId=...` list GET returns the seeded rows, and
     a single-conversation `/api/conversations/conv-N` GET (reconcile's own
     request) returns whatever that test wants the "server's real row" to
     say -- letting these assert the reorder is driven by the SERVER's own
     updatedAt, not a client-constructed one (the old bumpConversation used
     `new Date().toISOString()` here; reconcileConversationCount never
     constructs a timestamp at all).
     ---------------------------------------------------------------------- */
  describe("reconcileConversationCount ordering (#310, #438)", () => {
    const rows = (updatedAts: string[]) => ({
      items: updatedAts.map((updatedAt, i) => ({
        ...CONV_A,
        id: `conv-${i}`,
        title: `Chat ${i}`,
        updatedAt,
      })),
      nextCursor: null,
    });

    function stubFetch(
      listUpdatedAts: string[],
      singleResponses: Record<string, { messageCount?: number; updatedAt?: string }>,
    ) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const singleMatch = url.match(/^\/api\/conversations\/(conv-\d+)$/);
          if (singleMatch) {
            const id = singleMatch[1]!;
            const overrides = singleResponses[id] ?? {};
            return new Response(
              JSON.stringify({ ...CONV_A, id, updatedAt: overrides.updatedAt ?? CONV_A.updatedAt, messageCount: overrides.messageCount ?? CONV_A.messageCount }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify(rows(listUpdatedAts)), { status: 200 });
        }),
      );
    }

    it("does not reorder anything when the reconciled row is already first", async () => {
      stubFetch(
        ["2026-08-03T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
        { "conv-0": { messageCount: CONV_A.messageCount + 2, updatedAt: "2026-08-04T00:00:00.000Z" } },
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(3));
      const before = result.current.conversations;

      await act(async () => {
        await result.current.reconcileConversationCount("conv-0");
      });

      // The overwhelmingly common case: you are talking to the conversation
      // that is already at the top. Rows must not shuffle under a student
      // who might be reading them.
      expect(result.current.conversations.map((c) => c.id)).toEqual(before.map((c) => c.id));
      expect(result.current.conversations[0]!.messageCount).toBe(before[0]!.messageCount + 2);
    });

    it("moves a reconciled row to the front without disturbing the rest", async () => {
      stubFetch(
        ["2026-08-03T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
        { "conv-2": { messageCount: CONV_A.messageCount + 2, updatedAt: "2026-08-10T00:00:00.000Z" } },
      );
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(3));

      await act(async () => {
        await result.current.reconcileConversationCount("conv-2");
      });

      expect(result.current.conversations.map((c) => c.id)).toEqual(["conv-2", "conv-0", "conv-1"]);
    });
  });

  /* ------------------------------------------------------------------------
     #310: recentlyMovedId -- the rail's "a real reorder happened" signal,
     used to render a brief highlight on the row that moved. Same
     URL-routed fetch stub as the ordering block above.
     ---------------------------------------------------------------------- */
  describe("recentlyMovedId (#310, #438)", () => {
    const rows = (updatedAts: string[]) => ({
      items: updatedAts.map((updatedAt, i) => ({
        ...CONV_A,
        id: `conv-${i}`,
        title: `Chat ${i}`,
        updatedAt,
      })),
      nextCursor: null,
    });

    function stubFetch(singleUpdatedAts: Record<string, string>) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          const singleMatch = url.match(/^\/api\/conversations\/(conv-\d+)$/);
          if (singleMatch) {
            const id = singleMatch[1]!;
            return new Response(
              JSON.stringify({ ...CONV_A, id, updatedAt: singleUpdatedAts[id] ?? CONV_A.updatedAt, messageCount: CONV_A.messageCount + 2 }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify(rows(["2026-08-03T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-01T00:00:00.000Z"])),
            { status: 200 },
          );
        }),
      );
    }

    it("stays null when the reconciled row is already first (a no-op reorder)", async () => {
      stubFetch({ "conv-0": "2026-08-04T00:00:00.000Z" });
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(3));

      await act(async () => {
        await result.current.reconcileConversationCount("conv-0");
      });

      expect(result.current.recentlyMovedId).toBeNull();
    });

    it("is set to the reconciled row's id when a real reorder happens", async () => {
      stubFetch({ "conv-2": "2026-08-10T00:00:00.000Z" });
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(3));

      await act(async () => {
        await result.current.reconcileConversationCount("conv-2");
      });

      expect(result.current.recentlyMovedId).toBe("conv-2");
    });

    it("clears itself automatically after the highlight window", async () => {
      stubFetch({ "conv-2": "2026-08-10T00:00:00.000Z" });
      const { result } = renderHook(() => useTutorConversations("course-a"));
      // Real timers for the initial fetch/render settling -- testing-library's
      // waitFor polls on its own timers, which fake timers would also freeze.
      await waitFor(() => expect(result.current.conversations).toHaveLength(3));

      // Fake timers must be active BEFORE the reconcile call, not just
      // before advancing them -- setTimeout below is scheduled the moment
      // the reorder happens (inside reconcileConversationCount, once its
      // fetch resolves), so enabling fake timers afterward would leave that
      // timer registered against the real clock, immune to
      // advanceTimersByTime. The fetch mock itself resolves via a plain
      // microtask, not a real timer, so it still settles fine under fake
      // timers.
      vi.useFakeTimers();
      try {
        await act(async () => {
          await result.current.reconcileConversationCount("conv-2");
        });
        expect(result.current.recentlyMovedId).toBe("conv-2");

        act(() => {
          vi.advanceTimersByTime(1500);
        });
        expect(result.current.recentlyMovedId).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a second real reorder replaces the highlighted id rather than stacking", async () => {
      stubFetch({ "conv-2": "2026-08-10T00:00:00.000Z", "conv-1": "2026-08-11T00:00:00.000Z" });
      const { result } = renderHook(() => useTutorConversations("course-a"));
      await waitFor(() => expect(result.current.conversations).toHaveLength(3));

      await act(async () => {
        await result.current.reconcileConversationCount("conv-2");
      });
      expect(result.current.recentlyMovedId).toBe("conv-2");

      await act(async () => {
        // conv-2 is now first; conv-1 (second) is the one that moves this time.
        await result.current.reconcileConversationCount("conv-1");
      });
      expect(result.current.recentlyMovedId).toBe("conv-1");
    });
  });
});
