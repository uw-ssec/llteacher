// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import App from "./App";
import { useStudentHomework } from "./hooks/useStudentHomework";

vi.mock("./components/AuthProvider", () => ({
  useAuth: () => ({ isAuthenticated: true, loading: false, staffOnly: false, email: "student@example.edu" }),
}));
vi.mock("./hooks/useRExecution", () => ({ useRExecution: () => ({ run: vi.fn() }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const homeworks = [1, 2, 3].map((number) => ({
  id: `hw-${number}`, courseId: number === 3 ? "other-course" : "course-a", courseName: "Test course",
  title: `Homework ${number}`, description: "", dueDate: "2099-01-01T00:00:00Z",
  completedPercentage: 0, inProgressPercentage: 0, widgets: [],
  sections: [{ id: `section-${number}`, title: `Assignment ${number} section`, order: 1,
    status: "in_progress", conversationId: `conversation-${number}`, submissionSource: null }],
}));
const tutor = { id: "tutor-1", title: "My tutor chat", updatedAt: "2026-10-15T12:00:00Z", messageCount: 2 };

function setup() {
  vi.stubGlobal("CSS", { supports: () => true });
  Element.prototype.scrollIntoView = vi.fn();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/student/homeworks") return Response.json({ homeworks });
    if (url === "/api/hello") return Response.json({ ping_id: "12345678" });
    if (url.includes("/messages?")) return Response.json([{ id: `message-${url.split("/")[3]}`, seq: 1,
      role: "user", parts: [{ type: "text", text: `History for ${url.split("/")[3]}` }], createdAt: "2026-10-15T12:00:00Z" }]);
    if (url.endsWith("/hints")) return Response.json({ used: 0, limit: null });
    if (url.startsWith("/api/conversations?") || url === "/api/conversations") {
      return Response.json(init?.method === "POST" ? { ...tutor, id: "new-tutor", title: "New conversation" }
        : { items: [tutor], nextCursor: null });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Unified student navigation", () => {
  it("lists both assignments from the current course and opens the correct Section 1", async () => {
    setup();
    const user = userEvent.setup();
    render(<MemoryRouter><App /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "Homeworks" }));
    expect(screen.getByRole("button", { name: "Homeworks" }).getAttribute("aria-expanded")).toBe("true");
    await user.click(await screen.findByRole("button", { name: "Homework 2" }));
    expect(await screen.findByText("History for conversation-2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit section 1 for grading" })).toBeTruthy();
    expect(screen.queryByText("History for conversation-1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to course navigation" }));
    expect(screen.getByRole("button", { name: "Homeworks" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "Homework 3" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Homework 1" }));
    expect(await screen.findByText("History for conversation-1")).toBeTruthy();
  });

  it("opens a tutor detail, preserves its draft through overview, and creates via the inline plus", async () => {
    setup();
    const user = userEvent.setup();
    render(<MemoryRouter><App /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "Tutor Chats" }));
    await user.click(await screen.findByRole("button", { name: "Select conversation: My tutor chat" }));
    await screen.findByText("History for tutor-1");
    const composer = screen.getByLabelText("Message input") as HTMLTextAreaElement;
    await user.type(composer, "My unsent question");
    await user.click(screen.getByRole("button", { name: "Back to course navigation" }));
    expect(screen.queryByRole("button", { name: "Expand tutor conversations" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Select conversation: My tutor chat" }));
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).value).toBe("My unsent question");
    await user.click(screen.getByRole("button", { name: "Back to course navigation" }));
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByRole("button", { name: "Back to course navigation" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Select conversation: New conversation" })).toBeTruthy();
  });

  it("keeps late updates and live progress scoped to their original homework", async () => {
    setup();
    const { result } = renderHook(() => useStudentHomework());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const updateFirstHomework = result.current.setSections;
    act(() => result.current.selectHomework("hw-2"));
    act(() => updateFirstHomework((sections) => sections.map((section) => ({ ...section, status: "submitted" }))));
    expect(result.current.sections[0]?.status).toBe("current");
    act(() => result.current.selectHomework("hw-1"));
    expect(result.current.sections[0]?.status).toBe("submitted");
  });
});
