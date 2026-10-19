import { describe, expect, it, vi } from "vitest";
import { openStudentApp, studentAppUrl } from "./studentAppUrl";

describe("studentAppUrl", () => {
  it("opens Student view on the production origin", () => {
    expect(studentAppUrl("course-a", "https://teacher.example.edu")).toBe(
      "https://teacher.example.edu/?view=student&courseId=course-a",
    );
  });

  it.each([
    ["http://localhost:2312", "http://localhost:2311/"],
    ["http://127.0.0.1:2412", "http://127.0.0.1:2411/"],
  ])("maps the local admin origin %s to the student app", (origin, studentOrigin) => {
    const url = new URL(studentAppUrl("course / a", origin));

    expect(url.origin + url.pathname).toBe(studentOrigin);
    expect(url.searchParams.get("view")).toBe("student");
    expect(url.searchParams.get("courseId")).toBe("course / a");
  });

  it("navigates with window.location.assign semantics", () => {
    const assign = vi.fn();

    openStudentApp("course-a", assign, "https://teacher.example.edu");

    expect(assign).toHaveBeenCalledWith(
      "https://teacher.example.edu/?view=student&courseId=course-a",
    );
  });
});
