import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CourseSetupView } from "./CourseSetupView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("adding instructors to an existing course", () => {
  const course = {
    id: "course-1", title: "Statistics", code: "STAT 311", term: "Autumn 2026", status: "active",
    instructors: [{ userId: "u1", email: "ada@uw.edu" }],
  };
  const second = { userId: "u2", email: "grace@uw.edu" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  async function openForm(title = "Statistics") {
    const row = (await screen.findByRole("rowheader", { name: title })).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: `Add instructor to ${title}` }));
    return { row, form: within(row).getByRole("form", { name: `Add instructor to ${title}` }) };
  }

  it("adds to the selected course, keeps existing instructors and reloads the authoritative list", async () => {
    let listCalls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/platform/courses" && init?.method === "GET") {
        listCalls += 1;
        return json({ courses: [{ ...course, instructors: listCalls === 1 ? course.instructors : [...course.instructors, second] }] });
      }
      if (String(input) === "/api/platform/courses/course-1/instructors" && init?.method === "POST") {
        return json({ instructor: second, membershipAdded: true }, 201);
      }
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetch);
    render(<CourseSetupView />);
    const { row, form } = await openForm();
    fireEvent.change(within(form).getByLabelText("Instructor email for STAT 311 (Autumn 2026)"), { target: { value: "grace@uw.edu" } });
    fireEvent.submit(form);
    expect(within(row).getByText("ada@uw.edu")).toBeTruthy();
    expect((await within(row).findByRole("status")).textContent).toContain("grace@uw.edu");
    expect(await within(row).findByText("grace@uw.edu")).toBeTruthy();
    expect(within(row).getByText("ada@uw.edu")).toBeTruthy();
    expect(listCalls).toBe(2);
    expect(fetch.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body)
      .toBe('{"instructorEmail":"grace@uw.edu"}');
  });

  it("reports an already-assigned instructor as a safe repeat", async () => {
    let listCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return json({ instructor: course.instructors[0], membershipAdded: false });
      listCalls += 1;
      return json({ courses: [course] });
    }));
    render(<CourseSetupView />);
    const { row, form } = await openForm();
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "ada@uw.edu" } });
    fireEvent.submit(form);
    expect((await within(row).findByRole("status")).textContent).toMatch(/already.*instructor/i);
    expect(within(row).getAllByText("ada@uw.edu")).toHaveLength(1);
    expect(listCalls).toBe(2);
  });

  it.each([400, 500])("keeps the email and existing instructors after a %s failure", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "Cannot add this instructor" }, status) : json({ courses: [course] }),
    ));
    render(<CourseSetupView />);
    const { row, form } = await openForm();
    const input = within(form).getByRole("textbox");
    fireEvent.change(input, { target: { value: "grace@uw.edu" } });
    fireEvent.submit(form);
    expect((await within(row).findByRole("alert")).textContent).toContain("Cannot add this instructor");
    expect((input as HTMLInputElement).value).toBe("grace@uw.edu");
    expect(within(row).getByText("ada@uw.edu")).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Add instructor" }).matches(":disabled")).toBe(false);
  });

  it("blocks duplicate submissions without sharing pending state between courses", async () => {
    let finish!: (response: Response) => void;
    let postCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCalls += 1;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return json({ courses: [course, { ...course, id: "course-2", title: "Calculus", code: "MATH 124" }] });
    }));
    render(<CourseSetupView />);
    const first = await openForm();
    const other = await openForm("Calculus");
    fireEvent.change(within(first.form).getByRole("textbox"), { target: { value: "grace@uw.edu" } });
    fireEvent.submit(first.form);
    fireEvent.submit(first.form);
    expect(postCalls).toBe(1);
    expect(within(first.form).getByRole("button", { name: /Adding/ }).matches(":disabled")).toBe(true);
    expect(within(other.form).getByRole("button", { name: "Add instructor" }).matches(":disabled")).toBe(false);
    fireEvent.change(within(other.form).getByRole("textbox"), { target: { value: "third@uw.edu" } });
    finish(json({ instructor: second, membershipAdded: true }, 201));
    expect((await within(first.row).findByRole("status")).textContent).toContain("grace@uw.edu");
    expect((within(other.form).getByRole("textbox") as HTMLInputElement).value).toBe("third@uw.edu");
    expect(within(other.row).queryByRole("status")).toBeNull();
  });
});

describe("editing instructors on a course", () => {
  const course = {
    id: "course-1", title: "Statistics", code: "STAT 311", term: "Autumn 2026", status: "active",
    instructors: [{ userId: "u1", email: "ada@uw.edu" }, { userId: "u2", email: "grace@uw.edu" }],
  };

  it("marks instructors for removal, allows undo, and saves only selected course memberships", async () => {
    let listCalls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/platform/courses" && init?.method === "GET") {
        listCalls += 1;
        return new Response(JSON.stringify({ courses: [{ ...course, instructors: listCalls === 1 ? course.instructors : [course.instructors[1]] }] }), { status: 200 });
      }
      if (String(input) === "/api/platform/courses/course-1/instructors" && init?.method === "PATCH") {
        return new Response(JSON.stringify({ removedUserIds: ["u1"] }), { status: 200 });
      }
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", fetch);
    render(<CourseSetupView />);
    const row = (await screen.findByRole("rowheader", { name: "Statistics" })).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit instructors for Statistics" }));
    fireEvent.click(within(row).getByRole("button", { name: "Remove ada@uw.edu" }));
    expect(within(row).getByText("ada@uw.edu").closest("s")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Undo removal of ada@uw.edu" }));
    expect(within(row).getByText("ada@uw.edu").closest("s")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Remove ada@uw.edu" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save instructor changes" }));
    await waitFor(() => expect(within(row).queryByText("ada@uw.edu")).toBeNull());
    expect(within(row).getByText("grace@uw.edu")).toBeTruthy();
    expect(fetch.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body)
      .toBe('{"removeUserIds":["u1"]}');
  });

  it("keeps pending removals visible when saving fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ error: "Cannot update instructors" }), { status: 409 })
        : new Response(JSON.stringify({ courses: [course] }), { status: 200 }),
    ));
    render(<CourseSetupView />);
    const row = (await screen.findByRole("rowheader", { name: "Statistics" })).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Edit instructors for Statistics" }));
    fireEvent.click(within(row).getByRole("button", { name: "Remove ada@uw.edu" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save instructor changes" }));
    expect((await within(row).findByRole("alert")).textContent).toContain("Cannot update instructors");
    expect(within(row).getByText("ada@uw.edu").closest("s")).toBeTruthy();
  });
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
