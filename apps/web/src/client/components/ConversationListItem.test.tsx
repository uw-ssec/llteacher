// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationListItem } from "./ConversationListItem";
import type { ConversationListItemResponse } from "../../shared/types";

afterEach(cleanup);

const CONVERSATION: ConversationListItemResponse = {
  id: "conv-1",
  kind: "tutor",
  title: "Understanding p-values",
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
    const { container } = renderItem();
    expect(screen.getByText("Understanding p-values")).toBeTruthy();
    const countEl = container.querySelector(".tutor-conversation-item__count")!;
    expect(countEl.textContent).toBe("6 messages");
  });

  it("singularizes the message count's visually-hidden word for exactly one message", () => {
    const { container } = renderItem({ conversation: { ...CONVERSATION, messageCount: 1 } });
    const countEl = container.querySelector(".tutor-conversation-item__count")!;
    expect(countEl.textContent).toBe("1 message");
  });

  // #233: the row's aria-label stays a short, stable "Select conversation:
  // {title}" (matching every other query in this file) -- the time and
  // count reach assistive tech via aria-describedby instead, pointing at
  // the meta block that renders them (see ConversationListItem.tsx's own
  // #233 doc comment for why this is preferred over cramming everything
  // into one aria-label).
  it("exposes the time and count to assistive tech via aria-describedby on the row", () => {
    renderItem();
    const row = screen.getByRole("button", { name: "Select conversation: Understanding p-values" });
    const describedById = row.getAttribute("aria-describedby");
    expect(describedById).toBeTruthy();
    const description = document.getElementById(describedById!);
    expect(description?.textContent).toContain("6 messages");
  });

  // #295 redesign: the row itself is now a plain, non-interactive <div> --
  // NOT role="button" (see this file's own #295 doc comment for why: a
  // nested real <button> inside role="button" is an ARIA violation user
  // agents prune). The title TEXT is the select control, rendered as a
  // real sibling <button> by EditableTitle (its `onActivateValue` prop).
  describe("select (#295 redesign)", () => {
    it("calls onSelect when the title text/button is clicked", async () => {
      const { onSelect } = renderItem();
      await userEvent.click(screen.getByText("Understanding p-values"));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    // #295: the outer row is deliberately non-interactive now -- clicking
    // its background (away from the title button) does nothing. This
    // replaces the old row-is-role="button" test that asserted the
    // opposite; that behavior is exactly what #295 removed.
    it("does not call onSelect when clicking the row background away from the title/pencil", async () => {
      const { onSelect, container } = renderItem();
      const row = container.querySelector(".tutor-conversation-item")!;
      await userEvent.click(row);
      expect(onSelect).not.toHaveBeenCalled();
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
