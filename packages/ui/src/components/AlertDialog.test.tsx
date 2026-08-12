// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AlertDialog, type AlertDialogProps } from "./AlertDialog";

afterEach(cleanup);

/* jsdom implements <dialog>.open toggling but not showModal()/close() (they
   throw "Not implemented" until jsdom ships full support) -- stub both so
   the component's lifecycle effect can run without crashing the test, and
   have the stubs actually flip `.open` the way a real browser would, since
   the component reads it back to decide whether to call show/close again. */
function stubDialogMethods() {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
stubDialogMethods();

function ControlledAlertDialog(props: Omit<AlertDialogProps, "open" | "onCancel"> & { initialOpen: boolean }) {
  const { initialOpen, onConfirm, ...rest } = props;
  const [open, setOpen] = useState(initialOpen);
  return (
    <AlertDialog
      {...rest}
      open={open}
      onCancel={() => setOpen(false)}
      onConfirm={() => {
        onConfirm();
        setOpen(false);
      }}
    />
  );
}

describe("AlertDialog", () => {
  it("renders title and description with role=alertdialog when open", () => {
    render(
      <AlertDialog
        open
        title="Restart this section?"
        description="You'll lose your conversation so far."
        confirmLabel="Restart section"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "Restart this section?" });
    expect(dialog.textContent).toContain("You'll lose your conversation so far.");
  });

  it("labels the dialog via aria-labelledby/aria-describedby pointing at real elements", () => {
    render(
      <AlertDialog
        open
        title="Restart this section?"
        description="Body copy."
        confirmLabel="Restart section"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toContain("Restart this section?");
    expect(document.getElementById(describedBy!)?.textContent).toContain("Body copy.");
  });

  it("calls onConfirm when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <AlertDialog
        open
        title="t"
        description="d"
        confirmLabel="Restart section"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restart section" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AlertDialog
        open
        title="t"
        description="d"
        confirmLabel="Restart section"
        cancelLabel="Keep this conversation"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Keep this conversation" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on the native cancel event (Escape)", () => {
    const onCancel = vi.fn();
    render(
      <AlertDialog
        open
        title="t"
        description="d"
        confirmLabel="Restart section"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    fireEvent(dialog, new Event("cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on a backdrop click (click landing on the dialog element itself)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AlertDialog
        open
        title="t"
        description="d"
        confirmLabel="Restart section"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    // Click the <dialog> element itself, not a descendant -- simulates a
    // backdrop click (the actual ::backdrop isn't a real DOM node jsdom can
    // target, but a click whose event.target === the dialog element is the
    // same condition the component checks for).
    await user.click(screen.getByRole("alertdialog"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("does not call onCancel when a click lands on dialog content (title/description)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <AlertDialog
        open
        title="Restart this section?"
        description="Body copy."
        confirmLabel="Restart section"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByText("Body copy."));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("disables both actions and shows a busy confirm button while confirming", () => {
    render(
      <AlertDialog
        open
        title="t"
        description="d"
        confirmLabel="Restart section"
        cancelLabel="Keep this conversation"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        confirming
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Keep this conversation" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: /Restart section/ }).getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("does not render into the accessibility tree when closed", () => {
    render(
      <AlertDialog
        open={false}
        title="t"
        description="d"
        confirmLabel="Restart section"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("round-trips open -> confirmed -> closed through parent-owned state", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ControlledAlertDialog initialOpen title="t" description="d" confirmLabel="Restart section" onConfirm={onConfirm} />);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restart section" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
