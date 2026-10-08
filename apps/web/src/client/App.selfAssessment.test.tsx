// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import App from "./App";
import { AuthProvider } from "./components/AuthProvider";
import type { StudentHomeworkSummary, StudentProgressWidget } from "../shared/types";

afterEach(cleanup);

/* #165: the before/after self-assessment, driven through the real App. Only
   the network is substituted; what is under test is WHEN the check appears
   relative to the homework actually starting, and what it sends. */

const SECTION_ID = "11111111-1111-4111-8111-111111111111";
const COURSE_ID = "22222222-2222-4222-8222-222222222222";

function homework(
  sectionStatus: "not_started" | "in_progress" | "submitted",
  widgets: StudentProgressWidget[],
): StudentHomeworkSummary {
  return {
    id: "hw-1",
    courseId: COURSE_ID,
    courseName: "STAT 311",
    title: "Confidence intervals",
    description: "d",
    dueDate: "2099-01-01T00:00:00.000Z",
    completedPercentage: sectionStatus === "submitted" ? 100 : 0,
    inProgressPercentage: sectionStatus === "in_progress" ? 100 : 0,
    sections: [{
      id: SECTION_ID,
      title: "Intervals",
      order: 1,
      status: sectionStatus,
      conversationId: sectionStatus === "not_started" ? null : "33333333-3333-4333-8333-333333333333",
      submissionSource: sectionStatus === "submitted" ? "student" : null,
    }],
    widgets,
  };
}

const widget = (over: Partial<StudentProgressWidget> = {}): StudentProgressWidget => ({
  id: "44444444-4444-4444-8444-444444444444",
  prePrompt: "How confident are you with confidence intervals?",
  postPrompt: "How confident are you now?",
  order: 1,
  preValue: null,
  postValue: null,
  ...over,
});

type Call = { url: string; method: string; body: unknown };

function stubFetch(hw: StudentHomeworkSummary, widgetStatus = 200) {
  const calls: Call[] = [];
  vi.stubGlobal("CSS", { supports: () => true });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url === "/api/student/homeworks") return json({ homeworks: [hw] });
      if (url.startsWith("/api/widgets/")) return json({ ok: true }, widgetStatus);
      if (url.endsWith(`/sections/${SECTION_ID}/conversations`) && method === "POST") {
        return json({ id: "55555555-5555-4555-8555-555555555555", greetingMessageId: "g1", greetingParts: [{ type: "text", text: "Welcome." }] }, 201);
      }
      // Real wire shapes: the list is { items, nextCursor }; history is a row array.
      if (url.startsWith("/api/conversations?")) return json({ items: [], nextCursor: null });
      if (url.startsWith("/api/conversations/")) return json([]);
      if (url.includes("/hints")) return json({ count: 0, limit: null });
      return json({});
    }),
  );
  return calls;
}

const startCalls = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.url.endsWith(`/sections/${SECTION_ID}/conversations`));
const widgetCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("/api/widgets/"));

function renderApp() {
  render(
    <MemoryRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("App self-assessment (#165)", () => {
  it("asks the before rating ahead of the first section, and opens it only after saving", async () => {
    const calls = stubFetch(homework("not_started", [widget()]));
    renderApp();

    expect(await screen.findByRole("heading", { name: "How confident are you right now?" })).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "How confident are you with confidence intervals?" });
    // The homework must not have started behind the check.
    expect(startCalls(calls)).toHaveLength(0);

    fireEvent.change(slider, { target: { value: "3" } });
    await userEvent.click(screen.getByRole("button", { name: "Save and start" }));

    await waitFor(() => expect(startCalls(calls)).toHaveLength(1));
    expect(widgetCalls(calls)).toEqual([
      { url: "/api/widgets/44444444-4444-4444-8444-444444444444/response", method: "PATCH", body: { which: "pre", value: 3 } },
    ]);
    expect(screen.queryByRole("heading", { name: "How confident are you right now?" })).toBeNull();
  });

  it("lets the student skip: nothing is recorded and the section opens", async () => {
    const calls = stubFetch(homework("not_started", [widget()]));
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: "Skip for now" }));

    await waitFor(() => expect(startCalls(calls)).toHaveLength(1));
    expect(widgetCalls(calls)).toHaveLength(0);
  });

  it("keeps the check up with an error when the save fails, and does not start the homework", async () => {
    const calls = stubFetch(homework("not_started", [widget()]), 503);
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: "Save and start" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't be saved/);
    expect(screen.getByRole("heading", { name: "How confident are you right now?" })).toBeTruthy();
    expect(startCalls(calls)).toHaveLength(0);
  });

  it("asks the after rating once every section is submitted, and sends it as post", async () => {
    const calls = stubFetch(homework("submitted", [widget({ preValue: 3 })]));
    renderApp();

    expect(await screen.findByRole("heading", { name: "How confident are you now?" })).toBeTruthy();
    const slider = screen.getByRole("slider", { name: "How confident are you now?" });
    fireEvent.change(slider, { target: { value: "8" } });
    await userEvent.click(screen.getByRole("button", { name: "Save ratings" }));

    await waitFor(() => expect(widgetCalls(calls)).toHaveLength(1));
    expect(widgetCalls(calls)[0]!.body).toEqual({ which: "post", value: 8 });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "How confident are you now?" })).toBeNull());
  });

  it("does not ask before once the homework has started, nor after while sections remain", async () => {
    stubFetch(homework("in_progress", [widget()]));
    renderApp();

    // The section chat resumes as usual.
    expect(await screen.findByText(/Section 1: Intervals/)).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("asks nothing when the homework has no self-assessment", async () => {
    const calls = stubFetch(homework("not_started", []));
    renderApp();

    await waitFor(() => expect(startCalls(calls)).toHaveLength(1));
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
