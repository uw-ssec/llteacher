// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

function renderDialog(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const props = {
    open: true, title: "Delete Lecture 1?", body: <p>The tutor will no longer find it.</p>,
    confirmLabel: "Delete", onConfirm: vi.fn(), onCancel: vi.fn(), busy: false, ...over,
  };
  render(<ConfirmDialog {...props} />);
  return props;
}

describe("ConfirmDialog", () => {
  it("shows the title and body in a modal dialog when open, and nothing when closed", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Delete Lecture 1?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText(/no longer find it/)).toBeTruthy();
    cleanup();
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms and cancels from its buttons", () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("offers an optional checkbox and reports its state", () => {
    const onCheck = vi.fn();
    renderDialog({ checkbox: { label: "Also delete the original upload", checked: true, onChange: onCheck } });
    const box = screen.getByRole("checkbox", { name: "Also delete the original upload" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onCheck).toHaveBeenCalledWith(false);
  });

  it("keeps the confirm button disabled until the required phrase is typed", () => {
    renderDialog({ typeToConfirm: "DELETE" });
    const confirm = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE to confirm/ }), { target: { value: "delete" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /Type DELETE to confirm/ }), { target: { value: "DELETE" } });
    expect(confirm.disabled).toBe(false);
  });

  it("disables both buttons while busy", () => {
    renderDialog({ busy: true });
    expect((screen.getByRole("button", { name: /Delet/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("puts focus on Cancel when it opens, so Enter does not delete by accident", () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});
