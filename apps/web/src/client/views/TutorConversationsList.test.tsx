// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TutorConversationsList } from "./TutorConversationsList";
import type { ConversationListItemResponse } from "../../shared/types";

afterEach(cleanup);

const CONV_A: ConversationListItemResponse = {
  id: "conv-a",
  kind: "tutor",
  title: "Chat A",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  messageCount: 3,
};

// #223: presentational as of this fix -- conversations/loading/etc. all
// come from props (a single useTutorConversations instance App.tsx now
// owns and shares with the chat column's header) instead of this
// component fetching its own data. Tests inject props directly rather
// than mocking fetch.
function renderList(overrides: Partial<React.ComponentProps<typeof TutorConversationsList>> = {}) {
  const onSelectConversation = vi.fn();
  const onCreateConversation = vi.fn(async () => true);
  const onRenameConversation = vi.fn(async () => undefined);
  const onToggleCollapse = vi.fn();
  const utils = render(
    <TutorConversationsList
      courseId="course-a"
      courseContextLoading={false}
      conversations={[]}
      loading={false}
      loadError={false}
      awaitingCourseContext={false}
      onRetryLoad={() => {}}
      hasMore={false}
      selectedConversationId={undefined}
      onSelectConversation={onSelectConversation}
      onCreateConversation={onCreateConversation}
      onRenameConversation={onRenameConversation}
      isCollapsed={false}
      onToggleCollapse={onToggleCollapse}
      {...overrides}
    />,
  );
  return { ...utils, onSelectConversation, onCreateConversation, onRenameConversation, onToggleCollapse };
}

describe("TutorConversationsList", () => {
  it("shows the empty state when there are no conversations", () => {
    renderList();
    expect(screen.getByText("No conversations yet")).toBeTruthy();
  });

  it("renders each conversation it's given", () => {
    renderList({ conversations: [CONV_A] });
    expect(screen.getByText("Chat A")).toBeTruthy();
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  it("surfaces a distinct error message (not the empty state) on loadError", () => {
    renderList({ loadError: true });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/couldn't load/i);
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  it("does not show the empty state while still loading", () => {
    renderList({ loading: true, conversations: [] });
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  // #280: the list route pages at 50 with no load-more wired -- this makes
  // that ceiling visible instead of silent.
  describe("hasMore notice (#280)", () => {
    it("shows a notice when hasMore is true", () => {
      renderList({ conversations: [CONV_A], hasMore: true });
      expect(screen.getByText(/older ones aren't shown yet/i)).toBeTruthy();
    });

    it("does not show the notice when hasMore is false", () => {
      renderList({ conversations: [CONV_A], hasMore: false });
      expect(screen.queryByText(/older ones aren't shown yet/i)).toBeNull();
    });

    it("does not show the notice alongside loadError", () => {
      renderList({ loadError: true, hasMore: true });
      expect(screen.queryByText(/older ones aren't shown yet/i)).toBeNull();
    });
  });

  describe("create (#232/#235)", () => {
    it("clicking New Conversation calls onCreateConversation", async () => {
      const { onCreateConversation } = renderList();
      await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
      expect(onCreateConversation).toHaveBeenCalledTimes(1);
    });

    it("surfaces a visible, announced error when creation fails, reusing the alert element", async () => {
      const onCreateConversation = vi.fn(async () => false);
      renderList({ onCreateConversation });
      await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/couldn't create/i);
    });

    it("clears a prior create error once a later create succeeds", async () => {
      const onCreateConversation = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      renderList({ onCreateConversation });
      const btn = screen.getByRole("button", { name: "New conversation" });
      await userEvent.click(btn);
      await screen.findByRole("alert");
      await userEvent.click(btn);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("disables New Conversation while courseId hasn't loaded yet, with a reason reachable via aria-describedby", () => {
      renderList({ courseId: undefined, courseContextLoading: true });
      const btn = screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      const describedById = btn.getAttribute("aria-describedby");
      expect(describedById).toBeTruthy();
      expect(document.getElementById(describedById!)?.textContent).toMatch(/loading/i);
    });

    it("gives a different disabled reason when there's genuinely no course, not just still loading", () => {
      renderList({ courseId: undefined, courseContextLoading: false });
      const btn = screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement;
      const describedById = btn.getAttribute("aria-describedby");
      expect(document.getElementById(describedById!)?.textContent).toMatch(/no course/i);
    });

    it("enables New Conversation once courseId is present", () => {
      renderList({ courseId: "course-a" });
      const btn = screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("aria-describedby")).toBeNull();
    });
  });

  // #295: list-style: none strips list semantics in Safari/VoiceOver
  // without an explicit role="list" -- this rail took the "title becomes a
  // real button" alternative (not role="listbox"), so role="list" is the
  // one still required.
  it("marks the conversation rail as a list (#295)", () => {
    renderList({ conversations: [CONV_A] });
    expect(screen.getByRole("list", { name: "Tutor conversation list" })).toBeTruthy();
  });

  it("clicking an existing conversation's row calls onSelectConversation with its id", async () => {
    const { onSelectConversation } = renderList({ conversations: [CONV_A] });
    await userEvent.click(screen.getByRole("button", { name: "Select conversation: Chat A" }));
    expect(onSelectConversation).toHaveBeenCalledWith("conv-a");
  });

  it("marks the selected conversation's select control as current", () => {
    renderList({ conversations: [CONV_A], selectedConversationId: "conv-a" });
    const row = screen.getByRole("button", { name: "Select conversation: Chat A" });
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("collapse toggle reflects isCollapsed and calls onToggleCollapse when clicked", async () => {
    const { onToggleCollapse, rerender } = renderList({ isCollapsed: false });

    const expandedToggle = screen.getByRole("button", { name: "Collapse tutor conversations" });
    expect(expandedToggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(expandedToggle);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    rerender(
      <TutorConversationsList
        courseId="course-a"
        courseContextLoading={false}
        conversations={[]}
        loading={false}
        loadError={false}
        awaitingCourseContext={false}
        onRetryLoad={() => {}}
        hasMore={false}
        selectedConversationId={undefined}
        onSelectConversation={() => {}}
        onCreateConversation={async () => true}
        onRenameConversation={async () => undefined}
        isCollapsed
        onToggleCollapse={onToggleCollapse}
      />,
    );
    const collapsedToggle = screen.getByRole("button", { name: "Expand tutor conversations" });
    expect(collapsedToggle.getAttribute("aria-expanded")).toBe("false");
  });

  describe("rename", () => {
    it("clicking a row's pencil, then Enter, calls onRenameConversation with the new title", async () => {
      const { onRenameConversation } = renderList({ conversations: [CONV_A] });

      await userEvent.click(screen.getByRole("button", { name: "Rename: Chat A" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Renamed chat{Enter}");

      expect(onRenameConversation).toHaveBeenCalledWith("conv-a", "Renamed chat");
    });

    it("reports the failed row's error inline when onRenameConversation rejects", async () => {
      const onRenameConversation = vi.fn(async () => {
        throw new Error("Title already in use");
      });
      renderList({ conversations: [CONV_A], onRenameConversation });

      await userEvent.click(screen.getByRole("button", { name: "Rename: Chat A" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Attempted rename{Enter}");

      expect(await screen.findByRole("button", { name: "Rename: Chat A" })).toBeTruthy();
      expect(screen.getByText("Title already in use")).toBeTruthy();
    });
  });
});

/* --------------------------------------------------------------------------
   #293 / #310 / #290 -- rail feedback and failure handling.

   Each of these pins a state the rail could previously reach and render
   misleadingly. They are written against the props, not the hook, because
   this component is presentational (#223) -- the hook's own half of #293 is
   covered in useTutorConversations.test.ts.
   -------------------------------------------------------------------------- */
describe("TutorConversationsList empty state and course context (#293)", () => {
  it("does not claim 'No conversations yet' before course context has arrived", () => {
    // The exact state the rail hit on EVERY page load for one round-trip:
    // not loading, no error, zero rows -- but only because courseId hadn't
    // resolved. A returning student with eight conversations was told their
    // work was gone.
    renderList({
      courseId: undefined,
      courseContextLoading: true,
      awaitingCourseContext: true,
      loading: false,
      conversations: [],
    });
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });

  it("still shows the empty state once course context exists and the list is genuinely empty", () => {
    renderList({ awaitingCourseContext: false, loading: false, conversations: [] });
    expect(screen.getByText("No conversations yet")).toBeTruthy();
  });

  it("renders the disabled-button reason as visible text, not only sr-only/title", () => {
    renderList({ courseId: undefined, courseContextLoading: true, awaitingCourseContext: true });
    const reason = screen.getByText("Loading course information…");
    // The regression: this used to carry className="sr-only", so a sighted
    // student on a tablet -- no hover, so no title tooltip either -- got a
    // button that did nothing and said nothing.
    expect(reason.className).not.toContain("sr-only");
  });

  it("distinguishes 'still loading' from 'no course at all' in that visible reason", () => {
    renderList({ courseId: undefined, courseContextLoading: false, awaitingCourseContext: true });
    expect(screen.getByText(/No course selected yet/)).toBeTruthy();
  });
});

describe("TutorConversationsList load failure (#310)", () => {
  it("keeps showing the rows it already had when a refresh fails", () => {
    renderList({ loadError: true, conversations: [CONV_A] });
    // The rail no longer clears itself on a failed fetch, so the student's
    // conversations do not appear deleted by one 502 during a deploy.
    expect(screen.getByText(CONV_A.title)).toBeTruthy();
    expect(screen.getByText(/may be out of date/)).toBeTruthy();
  });

  it("offers a retry that calls back, rather than leaving the rail dead for the session", async () => {
    const onRetryLoad = vi.fn();
    renderList({ loadError: true, onRetryLoad });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
  });

  it("says 'couldn't load' rather than 'out of date' when there is genuinely nothing to show", () => {
    renderList({ loadError: true, conversations: [] });
    expect(screen.getByText("Couldn't load conversations.")).toBeTruthy();
  });
});

describe("TutorConversationsList selection feedback (#290)", () => {
  it("does not mark a pending row aria-current -- only the settled one is current (#389)", () => {
    renderList({
      conversations: [CONV_A, { ...CONV_A, id: "conv-b", title: "Chat B" }],
      selectedConversationId: CONV_A.id,
      pendingConversationId: "conv-b",
    });
    // aria-current marks THE current item. Two at once contradicts the live
    // region, which correctly says one of them is still loading.
    expect(document.querySelectorAll('[aria-current="true"]').length).toBe(1);
    // ...and it is the one actually on screen, not the one loading.
    expect(document.querySelector('[aria-current="true"]')?.textContent).toContain(CONV_A.title);
    // The pending row still reads as busy -- the click is still visibly
    // registered, which is what #290 was for.
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("marks the pending row busy and selected while its history is in flight", () => {
    renderList({
      conversations: [CONV_A],
      selectedConversationId: undefined,
      pendingConversationId: CONV_A.id,
    });
    // Selection state used to derive entirely from the FETCHED result, so
    // the whole in-flight window looked identical to a dead control.
    const busy = document.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy?.className).toContain("tutor-conversation-item--selected");
  });

  it("announces the in-flight selection, then the opened conversation", () => {
    const { rerender } = renderList({
      conversations: [CONV_A],
      pendingConversationId: CONV_A.id,
    });
    expect(screen.getByText(new RegExp(`Loading conversation ${CONV_A.title}`))).toBeTruthy();

    rerender(
      <TutorConversationsList
        courseId="course-a"
        courseContextLoading={false}
        conversations={[CONV_A]}
        loading={false}
        loadError={false}
        awaitingCourseContext={false}
        onRetryLoad={() => {}}
        hasMore={false}
        selectedConversationId={CONV_A.id}
        pendingConversationId={undefined}
        onSelectConversation={() => {}}
        onCreateConversation={async () => true}
        onRenameConversation={async () => undefined}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      />,
    );
    expect(screen.getByText(`Opened ${CONV_A.title}`)).toBeTruthy();
  });

  it("leaves a settled selection un-busy", () => {
    renderList({
      conversations: [CONV_A],
      selectedConversationId: CONV_A.id,
      pendingConversationId: undefined,
    });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
