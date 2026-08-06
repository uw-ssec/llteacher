import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { HomeworkEditView } from "./HomeworkEditView";
import type { LLMConfig } from "../lib/fixtures";

const LLM_CONFIGS: LLMConfig[] = [
  { id: "cfg-1", recordNumber: 1, name: "Default", modelName: "gpt-4o-mini", basePromptPreview: "", temperature: 0.7, maxCompletionTokens: 1000, isDefault: true, isActive: true, createdAt: "2026-01-01" },
];

const HOMEWORK = {
  id: "hw-1",
  title: "HW 1",
  description: "desc",
  // A full ISO string with seconds/ms/Z, as GET /homeworks/:id actually
  // returns -- I2 covers this getting converted into the datetime-local
  // input's required `YYYY-MM-DDTHH:mm` shape.
  dueDate: "2026-08-05T14:30:00.000Z",
  llmConfigId: null,
  status: "draft",
  publishedAt: null,
  releasedAt: null,
  isHidden: false,
  expiresAt: null,
  sections: [
    { id: "s1", title: "Sec 1", order: 1, content: "content 1", solution: null },
  ],
};

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("HomeworkEditView", () => {
  it("shows an error alert (not an infinite blank screen) when the initial load fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/failed to load homework/i)).toBeTruthy();
  });

  it("does not call /publish when saving without touching the publish checkbox", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW 1 updated" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes("/publish"))).toBe(false);
  });

  it("calls /publish with the new state when the publish checkbox is toggled", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox", { name: /published/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const publishCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes("/publish"));
    expect(publishCall).toBeTruthy();
    const publishBody = JSON.parse((publishCall![1] as RequestInit).body as string);
    expect(publishBody.publish).toBe(true);
  });

  // #166
  it("does not call /hide when saving without touching the Hidden checkbox", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW 1 updated" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes("/hide"))).toBe(false);
  });

  it("calls /hide with isHidden: true when the Hidden checkbox is toggled", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox", { name: /^hidden/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const hideCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes("/hide"));
    expect(hideCall).toBeTruthy();
    const hideBody = JSON.parse((hideCall![1] as RequestInit).body as string);
    expect(hideBody.isHidden).toBe(true);
  });

  // #166: "hidden" (Resolved Design Decision 17's precedence) can mask an
  // otherwise-draft homework's status -- the Publish checkbox default must
  // key off publishedAt, not the status string, or a hidden-but-never-
  // published homework would show "Published" incorrectly checked.
  it("does not show Published checked for a homework that is hidden but was never published", async () => {
    const hiddenDraft = { ...HOMEWORK, status: "hidden", isHidden: true, publishedAt: null };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => hiddenDraft });
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    const publishedCheckbox = screen.getByRole("checkbox", { name: /published/i }) as HTMLInputElement;
    expect(publishedCheckbox.checked).toBe(false);
    const hiddenCheckbox = screen.getByRole("checkbox", { name: /^hidden/i }) as HTMLInputElement;
    expect(hiddenCheckbox.checked).toBe(true);
  });

  it("does not call /publish when saving an already-scheduled homework without touching its release date", async () => {
    // The scenario the fix wave's I3 correction actually protects against:
    // a homework that already has a real releasedAt must not have it
    // silently re-PATCHed (or cleared) just because an unrelated field
    // changed. Both originalPublishState.releasedAt and the form's
    // defaultValues.releasedAt are derived from the same
    // toDatetimeLocalValue(hw.releasedAt) call, so they must compare equal
    // when untouched.
    const scheduledHomework = {
      ...HOMEWORK, status: "scheduled", publishedAt: "2020-01-01T00:00:00.000Z", releasedAt: "2099-01-01T09:00:00.000Z",
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => scheduledHomework });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW 1 updated" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes("/publish"))).toBe(false);
  });

  it("converts a full ISO dueDate into the datetime-local input's local YYYY-MM-DDTHH:mm shape", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => HOMEWORK });
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/due date/i)).toBeTruthy());

    const input = screen.getByLabelText(/due date/i) as HTMLInputElement;
    expect(input.value).not.toBe(HOMEWORK.dueDate);
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const d = new Date(HOMEWORK.dueDate);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(input.value).toBe(expected);
  });

  it("retries the publish PATCH with confirm:true when a 409 hasStudentActivity is confirmed", async () => {
    const publishedHomework = { ...HOMEWORK, status: "active", publishedAt: "2020-01-01T00:00:00.000Z" };
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => publishedHomework });
      }
      if (typeof url === "string" && url.endsWith("/publish")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (body.confirm === true) {
          return Promise.resolve({ ok: true, json: async () => ({ id: "hw-1", publishedAt: null, releasedAt: null }) });
        }
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: "conflict", hasStudentActivity: true }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSaved = vi.fn();
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={onSaved} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox", { name: /published/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework (mount), PATCH homework, PATCH /publish (409), retry PATCH /publish (confirm:true)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const publishCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("/publish"));
    expect(publishCalls).toHaveLength(2);
    const retryBody = JSON.parse((publishCalls[1]![1] as RequestInit).body as string);
    expect(retryBody.confirm).toBe(true);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("shows an error and does not retry when a 409 hasStudentActivity confirmation is dismissed", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      if (typeof url === "string" && url.endsWith("/publish")) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: "conflict", hasStudentActivity: true }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSaved = vi.fn();
    render(
      <HomeworkEditView courseId="course-a" homeworkId="hw-1" llmConfigs={LLM_CONFIGS} onSaved={onSaved} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox", { name: /published/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework (mount), PATCH homework, PATCH /publish (409) -- no retry
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const publishCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).includes("/publish"));
    expect(publishCalls).toHaveLength(1);
    await waitFor(() => expect(screen.getByText(/failed to save/i)).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
  });
});
