import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CourseSetupView } from "./CourseSetupView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CourseSetupView", () => {
  it("lists every course with status and all assigned instructors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/platform/courses" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ courses: [{
          id: "course-1",
          title: "Introduction to Statistics",
          code: "STAT 311",
          term: "Autumn 2026",
          status: "active",
          instructors: [
            { userId: "u1", email: "ada@uw.edu" },
            { userId: "u2", email: "grace@uw.edu" },
          ],
        }] }), { status: 200 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }));

    render(<CourseSetupView />);

    expect(await screen.findByRole("heading", { name: "All courses" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Introduction to Statistics" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "STAT 311" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Autumn 2026" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Active" })).toBeTruthy();
    expect(screen.getByText("ada@uw.edu")).toBeTruthy();
    expect(screen.getByText("grace@uw.edu")).toBeTruthy();
  });

  it("refreshes the course list after creating a shell", async () => {
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/platform/courses" && init?.method === "POST") {
        return new Response(JSON.stringify({
          status: "created",
          course: { id: "course-2", title: "Data Ethics", code: "INFO 350", term: "Winter 2027" },
          instructor: { userId: "u3", email: "prof@uw.edu" },
          organizationId: "org-1",
          membershipId: "membership-2",
          platformInstructorGrantCreated: true,
        }), { status: 201 });
      }
      if (url === "/api/platform/courses" && (!init?.method || init.method === "GET")) {
        listCalls += 1;
        return new Response(JSON.stringify({ courses: listCalls === 1 ? [] : [{
          id: "course-2",
          title: "Data Ethics",
          code: "INFO 350",
          term: "Winter 2027",
          status: "active",
          instructors: [{ userId: "u3", email: "prof@uw.edu" }],
        }] }), { status: 200 });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    }));

    render(<CourseSetupView />);
    expect(await screen.findByText("No courses yet")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Instructor email"), { target: { value: "prof@uw.edu" } });
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Data Ethics" } });
    fireEvent.change(screen.getByLabelText("Course code"), { target: { value: "INFO 350" } });
    fireEvent.change(screen.getByLabelText("Term"), { target: { value: "Winter 2027" } });
    fireEvent.click(screen.getByRole("button", { name: "Create course" }));

    expect(await screen.findByRole("rowheader", { name: "Data Ethics" })).toBeTruthy();
    expect(listCalls).toBe(2);
  });
});
