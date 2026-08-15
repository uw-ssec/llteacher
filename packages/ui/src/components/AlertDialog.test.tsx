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

  /* #317 review, blocking finding #5: Escape during an in-flight confirm
     used to close the native <dialog> (the browser's default action for the
     `cancel` event) while React's `open` prop stayed true forever after --
     the parent's cancel handler early-returns while confirming, so nothing
     ever flips `open` back to false, and a `[open]`-keyed effect never
     re-fires to reopen it. The two tests below cover the fix's two halves:
     preventDefault() stops the native close from ever happening, and the
     unconditional effect heals the DOM if it ever desyncs from `open`
     anyway (belt-and-suspenders for causes other than this one). */
  it("prevents the native close and does not call onCancel when Escape fires while confirming", () => {
    const onCancel = vi.fn();
    render(
      <AlertDialog
        open
        title="t"
        description="d"
        confirmLabel="Restart section"
        onConfirm={vi.fn()}
        onCancel={onCancel}
        confirming
      />,
    );
    const dialog = screen.getByRole("alertdialog");
    const cancelEvent = new Event("cancel", { cancelable: true });
    const preventDefaultSpy = vi.spyOn(cancelEvent, "preventDefault");
    fireEvent(dialog, cancelEvent);
    expect(preventDefaultSpy).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("self-heals the DOM dialog open state on a later render even when `open` itself hasn't changed", () => {
    function SelfHealingHarness({ open }: { open: boolean }) {
      const [, forceRender] = useState(0);
      return (
        <>
          <AlertDialog
            open={open}
            title="t"
            description="d"
            confirmLabel="Restart section"
            onConfirm={vi.fn()}
            onCancel={vi.fn()}
          />
          <button type="button" onClick={() => forceRender((n) => n + 1)}>
            re-render
          </button>
        </>
      );
    }
    render(<SelfHealingHarness open />);
    const dialog = screen.getByRole("alertdialog") as HTMLDialogElement;
    expect(dialog.hasAttribute("open")).toBe(true);

    // Simulate the DOM closing out from under React -- bypassing React
    // entirely, the same way the browser's own native Escape default action
    // would (independent of any listener, and independent of the `open`
    // prop, which stays `true` throughout).
    dialog.removeAttribute("open");
    expect(dialog.hasAttribute("open")).toBe(false);

    // A render with `open` unchanged must still re-assert showModal() --
    // the whole point of running the effect on every render instead of only
    // on `[open]` transitions.
    fireEvent.click(screen.getByRole("button", { name: "re-render" }));
    expect(dialog.hasAttribute("open")).toBe(true);
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
