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

  // #6: the select control is the meta (time + count) button, not the
  // title -- clicking the title now enters rename mode instead (see the
  // next describe block). This is the keyboard/AT-reachable equivalent of
  // what the single big <button> gave for free before the split.
  it("calls onSelect when the meta (select) control is clicked", async () => {
    const { onSelect } = renderItem();
    await userEvent.click(screen.getByRole("button", { name: "Select conversation: Understanding p-values" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("also calls onSelect when clicking the row background (mouse convenience)", async () => {
    const { onSelect, container } = renderItem();
    const row = container.querySelector(".tutor-conversation-item")!;
    await userEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks the select control as current when selected", () => {
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

  describe("rename (#6)", () => {
    it("clicking the title enters edit mode without also selecting the row", async () => {
      const { onSelect } = renderItem();
      await userEvent.click(screen.getByRole("button", { name: "Rename: Understanding p-values" }));
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

    it("does not render a rename trigger when isEditable is false", () => {
      renderItem({ isEditable: false });
      expect(screen.queryByRole("button", { name: /Rename:/ })).toBeNull();
      expect(screen.getByText("Understanding p-values")).toBeTruthy();
      // The select control is unaffected -- non-owner is a hypothetical
      // this component supports, not the real state of this list today.
      expect(screen.getByRole("button", { name: /Select conversation/ })).toBeTruthy();
    });
  });
});
