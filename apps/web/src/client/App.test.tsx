// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useStudentHomework } from "./App";

afterEach(cleanup);

// #160: useStudentHomework parsed the response body without checking
// res.ok, so an auth/server error rendered as an empty sidebar with no
// error surfaced -- these cover the two cases that must now be
// distinguishable: a non-ok response vs. a valid-but-empty homework list.
describe("useStudentHomework", () => {
  it("sets loadError on a non-ok response, instead of throwing inside the .then chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );
    const { result } = renderHook(() => useStudentHomework());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(true);
    expect(result.current.sections).toEqual([]);
  });

  it("does not set loadError for a valid response with zero homeworks (genuine empty state)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ homeworks: [] }), { status: 200 })),
    );
    const { result } = renderHook(() => useStudentHomework());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(false);
    expect(result.current.sections).toEqual([]);
  });

  it("does not set loadError and populates sections for a valid non-empty response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            homeworks: [
              {
                id: "hw-1", title: "HW 1", description: "d", dueDate: "2099-01-01T00:00:00.000Z",
                completedPercentage: 0, inProgressPercentage: 0,
                sections: [{ id: "s1", title: "Sec 1", order: 1, status: "not_started", conversationId: null }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const { result } = renderHook(() => useStudentHomework());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadError).toBe(false);
    expect(result.current.hwTitle).toBe("HW 1");
    expect(result.current.sections).toHaveLength(1);
  });
});
