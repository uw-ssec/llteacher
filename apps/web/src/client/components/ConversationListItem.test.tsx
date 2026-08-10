// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationListItem } from "./ConversationListItem";
import type { ConversationListItemResponse } from "../../shared/types";

afterEach(cleanup);

const CONVERSATION: ConversationListItemResponse = {
  id: "conv-1",
  ownerUserId: "u1",
  courseId: "course-a",
  sectionId: null,
  kind: "tutor",
  title: "Understanding p-values",
  isDeleted: false,
  deletedAt: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T12:30:00.000Z",
  messageCount: 6,
};

function renderItem(overrides: Partial<React.ComponentProps<typeof ConversationListItem>> = {}) {
  const onSelect = vi.fn();
  const onRename = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <ConversationListItem
      conversation={CONVERSATION}
      isSelected={false}
      onSelect={onSelect}
      onRename={onRename}
      {...overrides}
    />,
  );
  return { ...utils, onSelect, onRename };
}

describe("ConversationListItem", () => {
  it("renders the title and message count", () => {
    renderItem();
    expect(screen.getByText("Understanding p-values")).toBeTruthy();
    expect(screen.getByLabelText("6 messages").textContent).toBe("6");
  });

  it("singularizes the message count label for exactly one message", () => {
    renderItem({ conversation: { ...CONVERSATION, messageCount: 1 } });
    expect(screen.getByLabelText("1 message")).toBeTruthy();
  });

  // #6 (redesigned post-review): #4's original contract is restored --
  // the whole row, including the title, is the select control again. Only
  // a small pencil icon (see the "rename (#6)" describe block below) is
  // carved out for renaming.
  describe("select (restored #4 contract)", () => {
    it("calls onSelect when the row is clicked, including a click on the title text", async () => {
      const { onSelect } = renderItem();
      await userEvent.click(screen.getByText("Understanding p-values"));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("calls onSelect when clicking the row background away from the title/pencil", async () => {
      const { onSelect, container } = renderItem();
      const row = container.querySelector(".tutor-conversation-item")!;
      await userEvent.click(row);
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("is keyboard-reachable and activatable via Enter/Space, carrying an aria-label", async () => {
      const { onSelect } = renderItem();
      const row = screen.getByRole("button", { name: "Select conversation: Understanding p-values" });
      row.focus();
      expect(document.activeElement).toBe(row);
      await userEvent.keyboard("{Enter}");
      expect(onSelect).toHaveBeenCalledTimes(1);
      await userEvent.keyboard(" ");
      expect(onSelect).toHaveBeenCalledTimes(2);
    });

    it("marks the row as current when selected", () => {
      renderItem({ isSelected: true });
      expect(
        screen.getByRole("button", { name: "Select conversation: Understanding p-values" }).getAttribute(
          "aria-current",
        ),
      ).toBe("true");
    });

    it("does not set aria-current when not selected", () => {
      renderItem({ isSelected: false });
      expect(
        screen.getByRole("button", { name: "Select conversation: Understanding p-values" }).getAttribute(
          "aria-current",
        ),
      ).toBeNull();
    });
  });

  describe("rename (#6)", () => {
    it("clicking the pencil enters edit mode without also selecting the row", async () => {
      const { onSelect } = renderItem();
      await userEvent.click(screen.getByRole("button", { name: "Rename: Understanding p-values" }));
      expect(screen.getByLabelText("Edit title")).toBeTruthy();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("keyboard-activating the pencil (Enter) does not also select the row", async () => {
      const { onSelect } = renderItem();
      const pencil = screen.getByRole("button", { name: "Rename: Understanding p-values" });
      pencil.focus();
      await userEvent.keyboard("{Enter}");
      expect(screen.getByLabelText("Edit title")).toBeTruthy();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("Enter saves the new title via onRename", async () => {
      const { onRename } = renderItem();
      await userEvent.click(screen.getByRole("button", { name: "Rename: Understanding p-values" }));
      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "New name{Enter}");
      expect(onRename).toHaveBeenCalledWith("New name");
    });

    it("does not render a rename trigger when isEditable is false, but the row is still selectable", async () => {
      const { onSelect } = renderItem({ isEditable: false });
      expect(screen.queryByRole("button", { name: /Rename:/ })).toBeNull();
      expect(screen.getByText("Understanding p-values")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Select conversation: Understanding p-values" }));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });
  });
});
