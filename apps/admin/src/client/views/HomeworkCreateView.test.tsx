import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HomeworkCreateView } from "./HomeworkCreateView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/^title$/i), {
    target: { value: "Homework 1" },
  });
  fireEvent.change(screen.getByLabelText(/due date/i), {
    target: { value: "2099-01-01T09:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: /add section/i }));
  fireEvent.change(screen.getByLabelText(/section title/i), {
    target: { value: "Question 1" },
  });
  fireEvent.change(screen.getByLabelText(/section content/i), {
    target: { value: "Submit your age" },
  });
}

describe("HomeworkCreateView", () => {
  it("retries a failed later step against the draft already created", async () => {
    let publishAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "POST" &&
          url === "/api/courses/course-a/homeworks"
        ) {
          return new Response(JSON.stringify({ id: "draft-1" }), {
            status: 201,
          });
        }
        if (
          init?.method === "PATCH" &&
          url === "/api/courses/course-a/homeworks/draft-1"
        ) {
          return new Response(null, { status: 200 });
        }
        if (
          init?.method === "PATCH" &&
          url === "/api/courses/course-a/homeworks/draft-1/publish"
        ) {
          publishAttempts += 1;
          return new Response(null, {
            status: publishAttempts === 1 ? 400 : 200,
          });
        }
        throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    render(
      <HomeworkCreateView
        courseId="course-a"
        llmConfigs={[]}
        onCreated={onCreated}
        onCancel={vi.fn()}
      />,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("radio", { name: /publish now/i }));

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText(/couldn't completely save your homework/i);

    fireEvent.change(screen.getByLabelText(/^title$/i), {
      target: { value: "Homework 1 corrected" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /schedule for later/i }));
    fireEvent.change(screen.getByLabelText(/release date and time/i), {
      target: { value: "2099-02-01T09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("draft-1"));

    const postCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(postCalls).toHaveLength(1);
    const homeworkPatchCalls = fetchMock.mock.calls.filter(
      ([input, init]) =>
        init?.method === "PATCH" &&
        String(input) === "/api/courses/course-a/homeworks/draft-1",
    );
    expect(homeworkPatchCalls).toHaveLength(2);
    expect(JSON.parse(homeworkPatchCalls[1]![1]!.body as string)).toMatchObject(
      {
        title: "Homework 1 corrected",
        description: "",
        dueDate: "2099-01-01T09:00",
      },
    );
    const publishCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/publish"),
    );
    expect(publishCalls).toHaveLength(2);
    const publishBody = JSON.parse(publishCalls[1]![1]!.body as string);
    expect(publishBody.publish).toBe(true);
    expect(publishBody.releasedAt).toMatch(/^2099-02-01T\d{2}:00:00\.000Z$/);
    expect(publishBody.releasedAt).not.toBe("2099-02-01T09:00");
  });

  it("tells the instructor when a draft exists after a later save step fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "draft-1" }), { status: 201 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: "A section is missing its title" }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
    );
    render(
      <HomeworkCreateView
        courseId="course-a"
        llmConfigs={[]}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fillRequiredFields();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(
      /couldn't completely save your homework/i,
    );
    expect(alert.textContent).toMatch(/a section is missing its title/i);
    expect(alert.textContent).toMatch(/saved a draft for you in the meantime/i);
  });

  it("ignores another Save activation while creation is still in flight", async () => {
    let resolvePost!: (response: Response) => void;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const fetchMock = vi.fn(() => pendingPost);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <HomeworkCreateView
        courseId="course-a"
        llmConfigs={[]}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fillRequiredFields();

    const save = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(save);
    await waitFor(() => expect(save.getAttribute("aria-busy")).toBe("true"));
    fireEvent.click(save);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvePost(new Response(null, { status: 503 }));
    await screen.findByText(/couldn't save your homework/i);
  });

  it("does not publish before a requested visibility update succeeds", async () => {
    let hideAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST")
          return new Response(JSON.stringify({ id: "draft-1" }), {
            status: 201,
          });
        if (url.endsWith("/hide")) {
          hideAttempts += 1;
          return new Response(
            hideAttempts === 1
              ? JSON.stringify({ error: "Visibility could not be updated" })
              : null,
            {
              status: hideAttempts === 1 ? 503 : 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/publish"))
          return new Response(null, { status: 200 });
        if (init?.method === "PATCH")
          return new Response(null, { status: 200 });
        throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    render(
      <HomeworkCreateView
        courseId="course-a"
        llmConfigs={[]}
        onCreated={onCreated}
        onCancel={vi.fn()}
      />,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("radio", { name: /publish now/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^hidden/i }));

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /visibility could not be updated/i,
    );
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/publish"),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: /save as draft/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("draft-1"));
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/publish"),
      ),
    ).toBe(false);
  });

  it("reconciles visibility changed after a partial save before retrying publication", async () => {
    let publishAttempts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST")
          return new Response(JSON.stringify({ id: "draft-1" }), {
            status: 201,
          });
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
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    render(
      <HomeworkCreateView
        courseId="course-a"
        llmConfigs={[]}
        onCreated={onCreated}
        onCancel={vi.fn()}
      />,
    );
    fillRequiredFields();
    fireEvent.click(screen.getByRole("radio", { name: /publish now/i }));
    const hidden = screen.getByRole("checkbox", { name: /^hidden/i });
    fireEvent.click(hidden);

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await screen.findByText(/publication failed/i);
    fireEvent.click(hidden);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("draft-1"));

    const hideBodies = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("/hide"))
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(hideBodies).toEqual([
      { isHidden: true, expiresAt: null },
      { isHidden: false, expiresAt: null },
    ]);
  });

  it("saves an expiration even when the homework is not manually hidden", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ id: "draft-1" }), {
            status: 201,
          });
        }
        return new Response(null, { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <HomeworkCreateView
        courseId="course-a"
        llmConfigs={[]}
        onCreated={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fillRequiredFields();
    fireEvent.change(screen.getByLabelText(/expires at/i), {
      target: { value: "2099-03-01T09:00" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

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
      expiresAt: "2099-03-01T09:00",
    });
  });
});
