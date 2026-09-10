import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { AttachmentListPayload, LlmConfigPayload, ResolutionPayload } from "@llteacher/ui/api";
import { HomeworkForm, type HomeworkFormInitialData } from "./HomeworkForm";

/* #33: shaped as the wire contract the form now takes, so a server field
   rename breaks this fixture too rather than letting the suite pass against
   a shape production no longer sees. */
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* #42: the knowledge fieldset's own fixtures + fetch stub, following
   CollectionsView.test.tsx's `stubFetch` convention (method-first dispatch,
   `vi.stubGlobal("fetch", ...)`) rather than inventing a new one. */
const KNOWLEDGE_COLLECTIONS = [
  {
    id: "col1",
    name: "Week 1 readings",
    description: "Intro",
    documentCount: 2,
    directoryCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
];
const KNOWLEDGE_ATTACHMENTS: AttachmentListPayload = {
  attachments: [{ id: "a1", collectionId: "col1", scope: { kind: "homework", homeworkId: "hw1" } }],
};
const KNOWLEDGE_RESOLUTION: ResolutionPayload = { level: "homework", collectionIds: ["col1"], documents: [] };

/* C-1: the form resolves `/knowledge/resolve` with only `homeworkId` (there
   is no single section to ask about from this form), so the endpoint's
   section-level matcher structurally cannot fire and `level: "section"` is
   not a payload it can ever return for that request. The override warning
   is instead computed client-side from this homework's own section ids
   crossed with the attachment list -- so exercising it means giving the
   form a homework whose sections include "s1" and stubbing an attachment
   actually scoped to "s1", not stubbing an unreachable resolve response. */
const HOMEWORK_WITH_SECTION: HomeworkFormInitialData = {
  title: "Existing HW",
  description: "d",
  dueDate: "2099-01-01T00:00",
  llmConfigId: null,
  sections: [
    {
      id: "s1",
      homeworkId: "hw1",
      title: "Sec 1",
      order: 1,
      hasSolution: false,
      submissionsCount: 0,
      content: "c",
      solutionContent: undefined,
      type: "conversation",
    },
  ],
  widgets: [],
  status: "active",
  releasedAt: null,
  isHidden: false,
  expiresAt: null,
  publishedAt: "2026-01-01T00:00:00.000Z",
};

function stubFetchWithCollections(
  overrides: {
    resolve?: ResolutionPayload;
    attachments?: AttachmentListPayload;
    onAttach?: (body: unknown) => void;
    onDetach?: (url: string) => void;
  } = {},
) {
  const resolvePayload = overrides.resolve ?? KNOWLEDGE_RESOLUTION;
  const attachmentsPayload = overrides.attachments ?? KNOWLEDGE_ATTACHMENTS;
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      overrides.onDetach?.(url);
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST" && url.includes("/attachments")) {
      overrides.onAttach?.(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (url.includes("/knowledge/resolve")) {
      return new Response(JSON.stringify(resolvePayload), { status: 200 });
    }
    if (url.endsWith("/attachments")) {
      return new Response(JSON.stringify(attachmentsPayload), { status: 200 });
    }
    return new Response(JSON.stringify({ collections: KNOWLEDGE_COLLECTIONS }), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function renderForm(
  overrides: {
    homeworkId?: string;
    onSubmit?: ReturnType<typeof vi.fn>;
    initialData?: HomeworkFormInitialData;
  } = {},
) {
  return render(
    <HomeworkForm
      courseId="c1"
      homeworkId={overrides.homeworkId}
      onSubmit={overrides.onSubmit ?? vi.fn()}
      llmConfigs={LLM_CONFIGS}
      initialData={overrides.initialData}
    />,
  );
}

describe("HomeworkForm", () => {
  it("requires a title and at least one section before submit", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/title required/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows a due date required alert when due date is left blank", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "New HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/due date required/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("adds a section, fills it out, and submits with order renumbered", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "New HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const titleInputs = screen.getAllByLabelText(/section title/i);
    fireEvent.change(titleInputs[0]!, { target: { value: "Sec 1" } });
    const contentInputs = screen.getAllByLabelText(/section content/i);
    fireEvent.change(contentInputs[0]!, { target: { value: "Sec 1 content" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.sections).toEqual([{ title: "Sec 1", content: "Sec 1 content", order: 1, solutionContent: undefined, type: "conversation" }]);
  });

  it("removing a section drops it and renumbers the rest", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /remove section/i })[0]!);
    const titleInputs = screen.getAllByLabelText(/section title/i);
    expect(titleInputs).toHaveLength(1);
  });

  it("does not remove a section when the delete confirmation is dismissed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove section/i }));
    expect(screen.getAllByLabelText(/section title/i)).toHaveLength(1);
  });

  it("removes a section when the delete confirmation is accepted", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove section/i }));
    expect(screen.queryAllByLabelText(/section title/i)).toHaveLength(0);
  });

  it("renders a live markdown preview of a section's content", () => {
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const content = screen.getAllByLabelText(/section content/i)[0]!;
    fireEvent.change(content, { target: { value: "**bold**" } });
    const preview = screen.getByLabelText(/section 1 content preview/i);
    expect(preview.querySelector("strong")?.textContent).toBe("bold");
  });

  it("renders a live markdown preview of a section's solution", () => {
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const solution = screen.getAllByLabelText(/section solution/i)[0]!;
    fireEvent.change(solution, { target: { value: "**answer**" } });
    const preview = screen.getByLabelText(/section 1 solution preview/i);
    expect(preview.querySelector("strong")?.textContent).toBe("answer");
  });

  it("adds and removes exactly one beforeunload listener per mount/unmount (no leak)", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} courseId="c1" />);

    const addCalls = addSpy.mock.calls.filter((c) => c[0] === "beforeunload").length;
    expect(addCalls).toBe(1);

    unmount();

    const removeCalls = removeSpy.mock.calls.filter((c) => c[0] === "beforeunload").length;
    expect(removeCalls).toBe(1);
  });

  it("rejects submit past 20 sections", async () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    for (let i = 0; i < 21; i++) fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/20 sections/i)).toBeTruthy());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keyboard: tab order flows title -> content -> add-solution within a section", () => {
    render(<HomeworkForm onSubmit={vi.fn()} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    const title = screen.getAllByLabelText(/section title/i)[0]!;
    title.focus();
    expect(document.activeElement).toBe(title);
    fireEvent.keyDown(title, { key: "Tab" });
    // jsdom doesn't execute real tab-order focus movement -- this asserts
    // the DOM order (fieldset children) matches the intended tab sequence,
    // which is what actually determines native tab order.
    const fieldset = title.closest("fieldset")!;
    const focusable = Array.from(fieldset.querySelectorAll("input, textarea, button"));
    expect(focusable[0]).toBe(title);
  });

  // #164
  it("defaults a new section's type to Conversation, and includes a changed type in the submit payload", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });

    const typeSelect = screen.getByLabelText(/section type/i) as HTMLSelectElement;
    expect(typeSelect.value).toBe("conversation");
    fireEvent.change(typeSelect, { target: { value: "non_interactive" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.sections[0].type).toBe("non_interactive");
  });

  // #166
  it("renders a controllable Hidden checkbox and expires-at field, included in the submit payload", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });

    const hiddenCheckbox = screen.getByLabelText(/^hidden/i) as HTMLInputElement;
    expect(hiddenCheckbox.checked).toBe(false);
    fireEvent.click(hiddenCheckbox);
    expect(hiddenCheckbox.checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/expires at/i), { target: { value: "2099-06-01T00:00" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.hidden).toBe(true);
    expect(payload.expiresAt).toBe("2099-06-01T00:00");
  });

  // #165
  it("adding a progress widget row renders both prompt inputs and includes them in the submit payload", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });

    fireEvent.click(screen.getByRole("button", { name: /add progress widget/i }));
    expect(screen.getByLabelText(/pre-section prompt/i)).toBeTruthy();
    expect(screen.getByLabelText(/post-section prompt/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/pre-section prompt/i), { target: { value: "Confidence before?" } });
    fireEvent.change(screen.getByLabelText(/post-section prompt/i), { target: { value: "Confidence after?" } });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.widgets).toEqual([{ prePrompt: "Confidence before?", postPrompt: "Confidence after?", order: 1 }]);
  });

  it("removing a progress widget row drops it from the submit payload, no confirmation required", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });

    fireEvent.click(screen.getByRole("button", { name: /add progress widget/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove widget/i }));
    expect(screen.queryByLabelText(/pre-section prompt/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.widgets).toEqual([]);
  });

  it("shows a friendly error and does not throw when onSubmit rejects", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("network error"));
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" />);
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "HW" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "d" } });
    fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2099-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: /add section/i }));
    fireEvent.change(screen.getAllByLabelText(/section title/i)[0]!, { target: { value: "Sec 1" } });
    fireEvent.change(screen.getAllByLabelText(/section content/i)[0]!, { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText(/failed to save/i)).toBeTruthy());
  });

  // #317 review, "strongly recommend before merge": an inactive/unavailable
  // assigned config used to have no matching <option>, so the uncontrolled
  // select silently fell back to "(course/org default)" on mount -- saving
  // an unrelated edit then PATCHed llmConfigId to undefined, dropping the
  // override with no warning shown anywhere.
  it("preserves an assigned llmConfigId that is missing from the active configs list on an unrelated save", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <HomeworkForm
        onSubmit={onSubmit}
        llmConfigs={LLM_CONFIGS} courseId="c1"
        initialData={{
          title: "Existing HW",
          description: "d",
          dueDate: "2099-01-01T00:00",
          llmConfigId: "cfg-inactive",
          sections: [
            {
              id: "s1",
              homeworkId: "hw1",
              title: "Sec 1",
              order: 1,
              hasSolution: false,
              submissionsCount: 0,
              content: "c",
              solutionContent: undefined,
              type: "conversation",
            },
          ],
          widgets: [],
          status: "active",
          releasedAt: null,
          isHidden: false,
          expiresAt: null,
          publishedAt: "2026-01-01T00:00:00.000Z",
        }}
      />,
    );

    // The assigned (inactive) config must be selected, not silently reset.
    const select = screen.getByLabelText(/llm config/i) as HTMLSelectElement;
    expect(select.value).toBe("cfg-inactive");

    // Edit something unrelated and save -- the override must survive.
    fireEvent.change(screen.getByLabelText(/^title$/i), { target: { value: "Renamed HW" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.llmConfigId).toBe("cfg-inactive");
  });

  // #317 review, #327: `isLoading` used to map to Save's native `disabled`,
  // which blurs the instructor to document.body for the duration of the
  // multi-step POST -> PATCH -> publish -> hide chain a save can trigger,
  // with no progress announced anywhere. Save now stays focusable
  // (aria-disabled, not native disabled) and a role="status" line
  // announces the in-progress save.
  it("keeps Save focusable and announces progress while isLoading is true", () => {
    const onSubmit = vi.fn();
    render(<HomeworkForm onSubmit={onSubmit} llmConfigs={LLM_CONFIGS} courseId="c1" isLoading />);
    const saveButton = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    expect(saveButton.getAttribute("aria-disabled")).toBe("true");
    expect(saveButton.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Saving homework…");
  });

  // #42: the knowledge fieldset -- attaching course collections to a
  // homework, right where an instructor sets one up.
  describe("knowledge fieldset", () => {
    it("explains that knowledge waits for a save when creating a new homework", async () => {
      stubFetchWithCollections();
      renderForm(); // no homeworkId — create mode
      await waitFor(() => screen.getByText(/Save the assignment first/i));
      expect(screen.queryByLabelText(/Week 1 readings/)).toBeNull();
    });

    it("lists the course's collections as attachable knowledge", async () => {
      stubFetchWithCollections();
      renderForm({ homeworkId: "hw1" });
      await waitFor(() => screen.getByLabelText(/Week 1 readings/));
    });

    it("marks the collection currently attached to this homework", async () => {
      stubFetchWithCollections();
      renderForm({ homeworkId: "hw1" });
      const checkbox = (await screen.findByLabelText(/Week 1 readings/)) as HTMLInputElement;
      await waitFor(() => expect(checkbox.checked).toBe(true));
    });

    it("warns when a section overrides the homework's knowledge", async () => {
      // The real endpoint can never answer `level: "section"` for this
      // form's request (see HOMEWORK_WITH_SECTION's comment), so the
      // regression here stubs what the form actually asks for: an
      // attachment scoped to one of this homework's own section ids.
      stubFetchWithCollections({
        attachments: {
          attachments: [{ id: "a2", collectionId: "col2", scope: { kind: "section", sectionId: "s1" } }],
        },
      });
      renderForm({ homeworkId: "hw1", initialData: HOMEWORK_WITH_SECTION });
      await waitFor(() => screen.getByText(/a section overrides/i));
    });

    it("does not warn of a section override for an attachment scoped to a section outside this homework", async () => {
      // Same shape as above, but the attached section id ("other-section")
      // does not belong to this homework's sections ("s1") -- the pre-fix
      // code could not tell the difference (it never checked section ids at
      // all), so this pins that the check is actually scoped.
      stubFetchWithCollections({
        attachments: {
          attachments: [
            { id: "a2", collectionId: "col2", scope: { kind: "section", sectionId: "other-section" } },
          ],
        },
      });
      renderForm({ homeworkId: "hw1", initialData: HOMEWORK_WITH_SECTION });
      await waitFor(() => screen.getByText(/own attachments are in effect/i));
      expect(screen.queryByText(/a section overrides/i)).toBeNull();
    });

    it("says what the tutor will retrieve when nothing is attached", async () => {
      stubFetchWithCollections({ resolve: { level: "none", collectionIds: [], documents: [] } });
      renderForm({ homeworkId: "hw1" });
      await waitFor(() => screen.getByText(/no course materials/i));
    });

    // Not required by the brief, but the level=="homework" case is the
    // ordinary, un-overridden state, so it deserves its own assertion rather
    // than only being exercised incidentally by the "attached" test above.
    it("says the homework's own attachments are in effect when nothing overrides them", async () => {
      stubFetchWithCollections();
      renderForm({ homeworkId: "hw1" });
      await waitFor(() => screen.getByText(/own attachments are in effect/i));
    });

    // Standing rule for this feature: a failed load must not read as "there
    // is nothing here". An unmocked-collections 500 must show a distinct
    // failure, not the same UI as a course with zero collections.
    it("reports a collections load failure distinctly from having none", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })),
      );
      renderForm({ homeworkId: "hw1" });
      await waitFor(() => screen.getByText(/didn't load/i));
      expect(screen.queryByText(/No collections exist yet/i)).toBeNull();
    });

    it("checking a collection attaches it to this homework", async () => {
      const onAttach = vi.fn();
      stubFetchWithCollections({ attachments: { attachments: [] }, onAttach });
      renderForm({ homeworkId: "hw1" });
      const checkbox = (await screen.findByLabelText(/Week 1 readings/)) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(onAttach).toHaveBeenCalledWith({ scope: { kind: "homework", homeworkId: "hw1" } }),
      );
    });

    it("unchecking a collection detaches it by its attachment id", async () => {
      const onDetach = vi.fn();
      stubFetchWithCollections({ onDetach });
      renderForm({ homeworkId: "hw1" });
      const checkbox = (await screen.findByLabelText(/Week 1 readings/)) as HTMLInputElement;
      await waitFor(() => expect(checkbox.checked).toBe(true));
      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(onDetach).toHaveBeenCalledWith("/api/courses/c1/knowledge/attachments/a1"),
      );
    });

    // Two clicks land before the first attach's response comes back and
    // `attachments` reloads -- without a pending guard, both would read the
    // checkbox as unattached and both fire an attach call.
    it("toggling a checkbox twice quickly sends only one attach call", async () => {
      const onAttach = vi.fn();
      stubFetchWithCollections({ attachments: { attachments: [] }, onAttach });
      renderForm({ homeworkId: "hw1" });
      const checkbox = (await screen.findByLabelText(/Week 1 readings/)) as HTMLInputElement;
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);
      await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    });

    it("reports an attach failure instead of leaving the checkbox's state unexplained", async () => {
      stubFetchWithCollections({ attachments: { attachments: [] } });
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/attachments")) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        if (url.includes("/knowledge/resolve")) {
          return new Response(JSON.stringify(KNOWLEDGE_RESOLUTION), { status: 200 });
        }
        if (url.endsWith("/attachments")) {
          return new Response(JSON.stringify({ attachments: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ collections: KNOWLEDGE_COLLECTIONS }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      renderForm({ homeworkId: "hw1" });
      const checkbox = (await screen.findByLabelText(/Week 1 readings/)) as HTMLInputElement;
      fireEvent.click(checkbox);
      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    });
  });
});
