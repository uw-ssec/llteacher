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

describe("ConversationListItem", () => {
  it("renders the title and message count", () => {
    render(<ConversationListItem conversation={CONVERSATION} isSelected={false} onSelect={() => {}} />);
    expect(screen.getByText("Understanding p-values")).toBeTruthy();
    expect(screen.getByLabelText("6 messages").textContent).toBe("6");
  });

  it("singularizes the message count label for exactly one message", () => {
    render(
      <ConversationListItem
        conversation={{ ...CONVERSATION, messageCount: 1 }}
        isSelected={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByLabelText("1 message")).toBeTruthy();
  });

  it("calls onSelect when clicked", async () => {
    const onSelect = vi.fn();
    render(<ConversationListItem conversation={CONVERSATION} isSelected={false} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: /Understanding p-values/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks the row as current when selected", () => {
    render(<ConversationListItem conversation={CONVERSATION} isSelected onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Understanding p-values/ }).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("does not set aria-current when not selected", () => {
    render(<ConversationListItem conversation={CONVERSATION} isSelected={false} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Understanding p-values/ }).getAttribute("aria-current")).toBeNull();
  });
});
