import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { HomeworkEditView } from "./HomeworkEditView";
import type { LlmConfigPayload } from "@llteacher/ui/api";

/* #33: the shared wire contract, so a server field rename breaks this too
   rather than letting the suite pass against a shape production no longer
   sees. */
const LLM_CONFIGS: LlmConfigPayload[] = [
  {
    id: "cfg-1",
    recordNumber: 1,
    name: "Default",
    provider: "openrouter",
    modelName: "gpt-4o-mini",
    basePrompt: "",
    temperature: 0.7,
    maxCompletionTokens: 1000,
    fallbackLlmConfigId: null,
    isDefault: true,
    isActive: true,
    knowledgeEnabled: true,
    genuiToolkits: [],
    scopeCourseId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
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
    {
      id: "s1",
      title: "Sec 1",
      order: 1,
      content: "content 1",
      solution: null,
    },
  ],
  widgets: [],
};

afterEach(cleanup);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("HomeworkEditView", () => {
  it("shows an error alert (not an infinite blank screen) when the initial load fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/didn't load/i)).toBeTruthy();
  });

  it("does not call /publish when saving without changing the publication choice", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^title$/i), {
      target: { value: "HW 1 updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework, PATCH homework.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes("/publish"))).toBe(false);
  });

  it("calls /publish with the new state when Publish now is selected", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: /publish now/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework, PATCH homework, PATCH /publish.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const publishCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes("/publish"),
    );
    expect(publishCall).toBeTruthy();
    const publishBody = JSON.parse(
      (publishCall![1] as RequestInit).body as string,
    );
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
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^title$/i), {
      target: { value: "HW 1 updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework, PATCH homework.
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
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox", { name: /^hidden/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework, PATCH homework, PATCH /hide.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const hideCall = fetchMock.mock.calls.find((c) =>
      (c[0] as string).includes("/hide"),
    );
    expect(hideCall).toBeTruthy();
    const hideBody = JSON.parse((hideCall![1] as RequestInit).body as string);
    expect(hideBody.isHidden).toBe(true);
    expect(hideBody.expiresAt).toBeNull();
  });

  it("explicitly clears an existing expiration", async () => {
    const expiringHomework = {
      ...HOMEWORK,
      isHidden: true,
      expiresAt: "2099-03-01T09:00:00.000Z",
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({
          ok: true,
          json: async () => expiringHomework,
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText(/^title$/i);
    fireEvent.change(screen.getByLabelText(/expires at/i), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith("/hide")),
      ).toBe(true),
    );
    const hideCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/hide"),
    );
    expect(JSON.parse(hideCall![1]!.body as string)).toEqual({
      isHidden: true,
      expiresAt: null,
    });
  });

  it("updates an expiration while the homework remains unhidden", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({ ok: true, json: async () => HOMEWORK });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText(/^title$/i);
    fireEvent.change(screen.getByLabelText(/expires at/i), {
      target: { value: "2099-04-01T09:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).endsWith("/hide")),
      ).toBe(true),
    );
    const hideCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/hide"),
    );
    expect(JSON.parse(hideCall![1]!.body as string)).toEqual({
      isHidden: false,
      expiresAt: "2099-04-01T09:00",
    });
  });

  // #166: "hidden" (Resolved Design Decision 17's precedence) can mask an
  // otherwise-draft homework's status -- the publication choice must
  // key off publishedAt, not the status string, or a hidden-but-never-
  // published homework would show "Published" incorrectly checked.
  it("shows Save as draft for a hidden homework that was never published", async () => {
    const hiddenDraft = {
      ...HOMEWORK,
      status: "hidden",
      isHidden: true,
      publishedAt: null,
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => hiddenDraft });
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    const draftChoice = screen.getByRole("radio", {
      name: /save as draft/i,
    }) as HTMLInputElement;
    expect(draftChoice.checked).toBe(true);
    const hiddenCheckbox = screen.getByRole("checkbox", {
      name: /^hidden/i,
    }) as HTMLInputElement;
    expect(hiddenCheckbox.checked).toBe(true);
  });

  it("does not call /publish when saving an already-scheduled homework without touching its release date", async () => {
    // The scenario the originalPublishState comparison exists to protect:
    // a homework that already has a real releasedAt must not have it
    // silently re-PATCHed (or cleared) just because an unrelated field
    // changed. Both originalPublishState.releasedAt and the form's
    // defaultValues.releasedAt are derived from the same
    // toDatetimeLocalValue(hw.releasedAt) call, so they must compare equal
    // when untouched.
    const scheduledHomework = {
      ...HOMEWORK,
      status: "scheduled",
      publishedAt: "2020-01-01T00:00:00.000Z",
      releasedAt: "2099-01-01T09:00:00.000Z",
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({
          ok: true,
          json: async () => scheduledHomework,
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.change(screen.getByLabelText(/^title$/i), {
      target: { value: "HW 1 updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework, PATCH homework.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes("/publish"))).toBe(false);
  });

  it("shows Schedule for later when visibility masks a future scheduled release", async () => {
    const hiddenScheduled = {
      ...HOMEWORK,
      status: "hidden",
      isHidden: true,
      publishedAt: "2026-01-01T00:00:00.000Z",
      releasedAt: "2099-01-01T09:00:00.000Z",
    };
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => hiddenScheduled });
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const scheduled = (await screen.findByRole("radio", {
      name: /schedule for later/i,
    })) as HTMLInputElement;
    expect(scheduled.checked).toBe(true);
    expect(screen.getByLabelText(/release date and time/i)).toBeTruthy();
  });

  it("ignores another Save activation while an edit is still in flight", async () => {
    let resolvePatch!: (response: Response) => void;
    const pendingPatch = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method)
        return Promise.resolve(
          new Response(JSON.stringify(HOMEWORK), { status: 200 }),
        );
      return pendingPatch;
    });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText(/^title$/i);

    const save = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(save);
    await waitFor(() => expect(save.getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(save);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvePatch(new Response(null, { status: 200 }));
  });

  it("reports an exact late error without claiming already-saved edits were lost", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (!init?.method)
          return Promise.resolve(
            new Response(JSON.stringify(HOMEWORK), { status: 200 }),
          );
        if (url.endsWith("/hide")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "Visibility update failed" }),
              {
                status: 503,
                headers: { "content-type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 200 }));
      });
    global.fetch = fetchMock;
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText(/^title$/i);
    fireEvent.click(screen.getByRole("checkbox", { name: /^hidden/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(
      /couldn't completely save your homework/i,
    );
    expect(alert.textContent).toMatch(/some changes were saved/i);
    expect(alert.textContent).toMatch(/visibility update failed/i);
  });

  it("reconciles visibility changed after a partial edit before retrying publication", async () => {
    const hiddenDraft = { ...HOMEWORK, status: "hidden", isHidden: true };
    let publishAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!init?.method)
          return new Response(JSON.stringify(hiddenDraft), { status: 200 });
        if (url.endsWith("/publish")) {
          publishAttempts += 1;
          return new Response(
            publishAttempts === 1
              ? JSON.stringify({ error: "Publication failed" })
              : null,
            {
              status: publishAttempts === 1 ? 503 : 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(null, { status: 200 });
      },
    );
    global.fetch = fetchMock;
    const onSaved = vi.fn();
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText(/^title$/i);
    const hidden = screen.getByRole("checkbox", { name: /^hidden/i });
    fireEvent.click(hidden);
    fireEvent.click(screen.getByRole("radio", { name: /publish now/i }));

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText(/publication failed/i);
    fireEvent.click(hidden);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const hideBodies = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/hide"))
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(hideBodies).toEqual([
      { isHidden: false, expiresAt: null },
      { isHidden: true, expiresAt: null },
    ]);
  });

  it("converts a full ISO dueDate into the datetime-local input's local YYYY-MM-DDTHH:mm shape", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => HOMEWORK });
    render(
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/due date/i)).toBeTruthy(),
    );

    const input = screen.getByLabelText(/due date/i) as HTMLInputElement;
    expect(input.value).not.toBe(HOMEWORK.dueDate);
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const d = new Date(HOMEWORK.dueDate);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(input.value).toBe(expected);
  });

  it("retries the publish PATCH with confirm:true when a 409 hasStudentActivity is confirmed", async () => {
    const publishedHomework = {
      ...HOMEWORK,
      status: "active",
      publishedAt: "2020-01-01T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
          return Promise.resolve({
            ok: true,
            json: async () => publishedHomework,
          });
        }
        if (typeof url === "string" && url.endsWith("/publish")) {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          if (body.confirm === true) {
            return Promise.resolve({
              ok: true,
              json: async () => ({
                id: "hw-1",
                publishedAt: null,
                releasedAt: null,
              }),
            });
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
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: /save as draft/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework (mount), PATCH homework, PATCH /publish (409), retry PATCH
    // /publish (confirm:true).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const publishCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes("/publish"),
    );
    expect(publishCalls).toHaveLength(2);
    const retryBody = JSON.parse(
      (publishCalls[1]![1] as RequestInit).body as string,
    );
    expect(retryBody.confirm).toBe(true);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("shows an error and does not retry when a 409 hasStudentActivity confirmation is dismissed", async () => {
    const publishedHomework = {
      ...HOMEWORK,
      status: "active",
      publishedAt: "2020-01-01T00:00:00.000Z",
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.endsWith(`/homeworks/hw-1`)) {
        return Promise.resolve({
          ok: true,
          json: async () => publishedHomework,
        });
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
      <HomeworkEditView
        courseId="course-a"
        homeworkId="hw-1"
        llmConfigs={LLM_CONFIGS}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/^title$/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: /save as draft/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // GET homework (mount), PATCH homework, PATCH /publish (409) -- no retry.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const publishCalls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes("/publish"),
    );
    expect(publishCalls).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByText(/publication was not changed/i)).toBeTruthy(),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
