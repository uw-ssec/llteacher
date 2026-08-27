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
    expect(screen.getByText(/Start one to ask about anything outside a section\./)).toBeTruthy();
  });

  it("renders each conversation it's given", () => {
    renderList({ conversations: [CONV_A] });
    expect(screen.getByText("Chat A")).toBeTruthy();
    expect(screen.queryByText(/Start one to ask about anything outside a section\./)).toBeNull();
  });

  it("surfaces a distinct error message (not the empty state) on loadError", () => {
    renderList({ loadError: true });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/couldn't load/i);
    expect(screen.queryByText(/Start one to ask about anything outside a section\./)).toBeNull();
  });

  it("does not show the empty state while still loading", () => {
    renderList({ loading: true, conversations: [] });
    expect(screen.queryByText(/Start one to ask about anything outside a section\./)).toBeNull();
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
   #289: the delete affordance.

   DELETE /api/conversations/:id shipped ownership-checked, 404-on-not-owned
   and FK-safe, and no client code called it -- from the student's side the
   rail was append-only.
   -------------------------------------------------------------------------- */
describe("TutorConversationsList delete (#289)", () => {
  /* jsdom toggles <dialog>.open but does not implement showModal()/close().
     Same stub the design system's own AlertDialog.test.tsx uses -- copied
     rather than shared because it patches a global prototype, and a helper
     imported across package boundaries to do that would be a worse thing to
     own than four lines. The stubs flip `.open` the way a real browser
     would, since AlertDialog reads it back before acting. */
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };

  it("offers no delete affordance when the caller supplies no handler", () => {
    renderList({ conversations: [CONV_A] });
    expect(screen.queryByRole("button", { name: /^Delete conversation/ })).toBeNull();
  });

  it("names the conversation in the control, so rows are distinguishable", () => {
    renderList({ conversations: [CONV_A], onDeleteConversation: vi.fn(async () => true) });
    // "Delete" alone is identical across every row in a list.
    expect(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` })).toBeTruthy();
  });

  it("confirms before deleting, and does not delete on cancel", async () => {
    const onDeleteConversation = vi.fn(async () => true);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    // Deletion is soft server-side but irreversible from this UI -- there is
    // no undo and no trash view, so one click must not be enough.
    expect(onDeleteConversation).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete this conversation\?/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDeleteConversation).not.toHaveBeenCalled();
  });

  it("deletes on confirm and announces it", async () => {
    const onDeleteConversation = vi.fn(async () => true);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDeleteConversation).toHaveBeenCalledWith(CONV_A.id);
    expect(await screen.findByText(`Deleted ${CONV_A.title}`)).toBeTruthy();
  });

  it("keeps the dialog open and says so when the delete fails", async () => {
    const onDeleteConversation = vi.fn(async () => false);
    renderList({ conversations: [CONV_A], onDeleteConversation });

    await userEvent.click(screen.getByRole("button", { name: `Delete conversation: ${CONV_A.title}` }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Closing on failure would leave the student unsure whether it happened,
    // and the row is still there.
    expect(await screen.findByText(/Couldn't delete that conversation/)).toBeTruthy();
    expect(screen.getByText(/has not been deleted/)).toBeTruthy();
  });
});
