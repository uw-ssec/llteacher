// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditableTitle, type EditableTitleProps } from "./EditableTitle";

afterEach(cleanup);

/* EditableTitle is a controlled component -- a successful save is only
   ever reflected in the read-only view once the PARENT re-renders it with
   a new `value` prop (exactly like TutorConversationsList's hook state or
   App.tsx's tutor-conversation title state will in production). This
   harness stands in for that parent so save-success tests exercise the
   real round trip instead of asserting on a value this component has no
   business mutating itself. */
function ControlledEditableTitle(props: Omit<EditableTitleProps, "value" | "onSave"> & {
  initialValue: string;
  onSave: (newTitle: string) => Promise<void> | void;
}) {
  const { initialValue, onSave, ...rest } = props;
  const [value, setValue] = useState(initialValue);
  return (
    <EditableTitle
      {...rest}
      value={value}
      onSave={async (newTitle) => {
        await onSave(newTitle);
        setValue(newTitle);
      }}
    />
  );
}

describe("EditableTitle", () => {
  it("renders the value read-only with a keyboard-reachable rename trigger", () => {
    render(<EditableTitle value="Understanding p-values" onSave={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Rename: Understanding p-values" });
    expect(trigger).toBeTruthy();
    expect(screen.getByText("Understanding p-values")).toBeTruthy();
    // Native <button> -- reachable via Tab and activatable via Enter/Space
    // with no extra tabIndex plumbing needed.
    expect(trigger.tagName).toBe("BUTTON");
  });

  it("does not render a rename affordance when isEditable is false (non-owner)", async () => {
    const onSave = vi.fn();
    render(<EditableTitle value="Someone else's chat" onSave={onSave} isEditable={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Someone else's chat")).toBeTruthy();
    // Clicking the plain text does nothing -- there's no click handler to fire.
    await userEvent.click(screen.getByText("Someone else's chat"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Edit title")).toBeNull();
  });

  it("clicking the title enters edit mode with a pre-filled, focused input carrying an aria-label", async () => {
    render(<EditableTitle value="Original title" onSave={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Original title");
    expect(document.activeElement).toBe(input);
  });

  it("Enter saves the trimmed value", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ControlledEditableTitle initialValue="Original title" onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title");
    await userEvent.clear(input);
    await userEvent.type(input, "  New title  {Enter}");

    expect(onSave).toHaveBeenCalledWith("New title");
    // Back to the read-only view, showing what onSave resolved with.
    expect(await screen.findByRole("button", { name: "Rename: New title" })).toBeTruthy();
  });

  it("blur saves", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <div>
        <EditableTitle value="Original title" onSave={onSave} />
        <button type="button">elsewhere</button>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));
    const input = screen.getByLabelText("Edit title");
    await userEvent.clear(input);
    await userEvent.type(input, "Blurred title");
    await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));

    expect(onSave).toHaveBeenCalledWith("Blurred title");
  });

  it("Escape cancels without saving and reverts to the prior title", async () => {
    const onSave = vi.fn();
    render(<EditableTitle value="Original title" onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title");
    await userEvent.clear(input);
    await userEvent.type(input, "Changed but abandoned{Escape}");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename: Original title" })).toBeTruthy();
    expect(screen.queryByLabelText("Edit title")).toBeNull();
  });

  it("rejects empty-after-trim input with an inline error, without calling onSave, staying in edit mode", async () => {
    const onSave = vi.fn();
    render(<EditableTitle value="Original title" onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title");
    await userEvent.clear(input);
    await userEvent.type(input, "   {Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/cannot be empty/i);
    // Still editing -- the input is still there for the student to fix.
    expect(screen.getByLabelText("Edit title")).toBeTruthy();
  });

  it("rejects input over maxLength with an inline error, without calling onSave, staying in edit mode", async () => {
    const onSave = vi.fn();
    render(<EditableTitle value="Original title" onSave={onSave} maxLength={10} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title") as HTMLInputElement;
    // maxLength on the input itself would clamp typed keystrokes at the DOM
    // level -- set the overlong value directly (mirrors, e.g., a paste)
    // to actually exercise the component's own validation branch.
    (input as HTMLInputElement).removeAttribute("maxlength");
    await userEvent.clear(input);
    await userEvent.type(input, "this is way too long{Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/10 characters or fewer/i);
    expect(screen.getByLabelText("Edit title")).toBeTruthy();
  });

  it("on a rejected save, reverts the displayed title, shows an inline error, and exits edit mode", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Title already in use"));
    render(<EditableTitle value="Original title" onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title");
    await userEvent.clear(input);
    await userEvent.type(input, "Attempted new title{Enter}");

    expect(onSave).toHaveBeenCalledWith("Attempted new title");
    // Reverted to the old title (Testing Strategy #2's "UI reverts to the
    // old title AND shows inline error") -- not left showing the failed
    // attempt, and no longer editing.
    expect(await screen.findByRole("button", { name: "Rename: Original title" })).toBeTruthy();
    expect(screen.queryByLabelText("Edit title")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Title already in use");
  });

  it("disables the input while a save is in flight, preventing overlapping submits", async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<ControlledEditableTitle initialValue="Original title" onSave={onSave} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "New title{Enter}");

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(true);

    resolveSave();
    await screen.findByRole("button", { name: "Rename: New title" });
  });
});
