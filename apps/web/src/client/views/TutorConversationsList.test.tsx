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
