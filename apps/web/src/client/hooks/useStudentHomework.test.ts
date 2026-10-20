// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useStudentHomework, type InstructorPreviewCourse } from "./useStudentHomework";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const courseA: InstructorPreviewCourse = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "STAT 311",
  title: "Elements of Statistical Methods",
  term: "Autumn 2026",
};

describe("useStudentHomework instructor preview", () => {
  it("uses the course-scoped endpoint and preserves course context for an empty homework list", async () => {
    const fetchMock = vi.fn(async () => Response.json({ homeworks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useStudentHomework({ previewCourse: courseA }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledWith(`/api/courses/${courseA.id}/student-view/homeworks`);
    expect(result.current.courseId).toBe(courseA.id);
    expect(result.current.courseName).toBe("STAT 311 · Elements of Statistical Methods");
    expect(result.current.homeworks).toEqual([]);
  });

  it("clears prior course state immediately and ignores a stale preview response", async () => {
    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    const responseA = new Promise<Response>((resolve) => { resolveA = resolve; });
    const responseB = new Promise<Response>((resolve) => { resolveB = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).includes(courseA.id) ? responseA : responseB));
    const courseB = { ...courseA, id: "22222222-2222-4222-8222-222222222222", code: "BIOL 180", title: "Intro Biology" };

    const { result, rerender } = renderHook(
      ({ previewCourse }: { previewCourse: InstructorPreviewCourse }) => useStudentHomework({ previewCourse }),
      { initialProps: { previewCourse: courseA } },
    );
    rerender({ previewCourse: courseB });
    expect(result.current.courseId).toBe(courseB.id);
    expect(result.current.homeworks).toEqual([]);

    await act(async () => resolveA(Response.json({ homeworks: [{
      id: "old-homework", courseId: courseA.id, courseName: courseA.title, title: "Old", description: "",
      dueDate: "2099-01-01T00:00:00Z", completedPercentage: 0, inProgressPercentage: 0, sections: [], widgets: [],
    }] })));
    expect(result.current.homeworks).toEqual([]);

    await act(async () => resolveB(Response.json({ homeworks: [] })));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.courseId).toBe(courseB.id);
  });
});
