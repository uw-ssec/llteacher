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
  // #6 redesign (post-review): the title TEXT is plain/non-interactive --
  // only the small pencil-icon button beside it enters edit mode. This
  // lets a consumer like ConversationListItem make the title text part of
  // a bigger "select this row" click target without it also triggering
  // rename (see that file's doc comment).
  it("renders the value as plain text with a separate, keyboard-reachable pencil rename trigger", () => {
    render(<EditableTitle value="Understanding p-values" onSave={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Rename: Understanding p-values" });
    expect(trigger).toBeTruthy();
    // Native <button> -- reachable via Tab and activatable via Enter/Space
    // with no extra tabIndex plumbing needed.
    expect(trigger.tagName).toBe("BUTTON");
    // The value text itself is NOT inside that button -- it's a sibling,
    // non-interactive span.
    const value = screen.getByText("Understanding p-values");
    expect(value.closest("button")).toBeNull();
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

  it("clicking the title TEXT (not the pencil) does not enter edit mode", async () => {
    render(<EditableTitle value="Original title" onSave={() => {}} />);
    await userEvent.click(screen.getByText("Original title"));
    expect(screen.queryByLabelText("Edit title")).toBeNull();
  });

  it("clicking the pencil enters edit mode with a pre-filled, focused input carrying an aria-label", async () => {
    render(<EditableTitle value="Original title" onSave={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

    const input = screen.getByLabelText("Edit title") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("Original title");
    expect(document.activeElement).toBe(input);
  });

  // The scenario ConversationListItem actually relies on: the pencil sits
  // inside a larger clickable "select this row" element, so its own click
  // must never bubble into that ancestor's handler.
  it("clicking the pencil does not propagate to an ancestor click handler", async () => {
    const onAncestorClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onAncestorClick}>
        <EditableTitle value="Original title" onSave={() => {}} />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));
    expect(onAncestorClick).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Edit title")).toBeTruthy();
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
    // #310: this used to need `input.removeAttribute("maxlength")` to get
    // here at all -- the native clamp meant the component's own validation
    // branch was unreachable in production, and the workaround was the
    // proof. The attribute is gone now, so typing past the limit is a real
    // thing a student can do and this is a real path.
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

  // #295: onActivateValue turns the value span into a real, sibling
  // <button> -- the shape ConversationListItem now relies on instead of
  // wrapping the whole row in role="button".
  describe("onActivateValue (#295)", () => {
    it("renders the value as a real button carrying activateLabel/activateDescribedBy/isActive, calling onActivateValue on click", async () => {
      const onActivateValue = vi.fn();
      render(
        <EditableTitle
          value="Understanding p-values"
          onSave={() => {}}
          onActivateValue={onActivateValue}
          activateLabel="Select conversation: Understanding p-values"
          activateDescribedBy="meta-1"
          isActive={true}
        />,
      );
      const valueBtn = screen.getByRole("button", { name: "Select conversation: Understanding p-values" });
      expect(valueBtn.tagName).toBe("BUTTON");
      expect(valueBtn.getAttribute("aria-describedby")).toBe("meta-1");
      expect(valueBtn.getAttribute("aria-current")).toBe("true");

      await userEvent.click(valueBtn);
      expect(onActivateValue).toHaveBeenCalledTimes(1);

      // The pencil is a distinct, adjacent button -- not nested inside the
      // value button (would reproduce the #295 ARIA violation).
      const pencil = screen.getByRole("button", { name: "Rename: Understanding p-values" });
      expect(valueBtn.contains(pencil)).toBe(false);
    });

    it("omits aria-current when isActive is false/omitted", () => {
      render(
        <EditableTitle
          value="Chat A"
          onSave={() => {}}
          onActivateValue={() => {}}
          activateLabel="Select conversation: Chat A"
        />,
      );
      expect(
        screen.getByRole("button", { name: "Select conversation: Chat A" }).getAttribute("aria-current"),
      ).toBeNull();
    });

    it("also renders the value as an activate button when isEditable is false", async () => {
      const onActivateValue = vi.fn();
      render(
        <EditableTitle
          value="Someone else's chat"
          onSave={() => {}}
          isEditable={false}
          onActivateValue={onActivateValue}
          activateLabel="Select conversation: Someone else's chat"
        />,
      );
      // No rename affordance (non-owner), but the value itself is still
      // the real select button.
      expect(screen.queryByRole("button", { name: /Rename:/ })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Select conversation: Someone else's chat" }));
      expect(onActivateValue).toHaveBeenCalledTimes(1);
    });

    it("without onActivateValue, the value stays plain non-interactive text (default/unchanged behavior)", () => {
      render(<EditableTitle value="Plain title" onSave={() => {}} />);
      const value = screen.getByText("Plain title");
      expect(value.tagName).not.toBe("BUTTON");
    });
  });

  // #298: exiting edit mode must restore focus to the pencil that opened
  // it, not drop it to <body> -- all three exit paths (save, save-failure,
  // Escape).
  describe("focus restoration on exit (#298)", () => {
    it("restores focus to the pencil after Escape", async () => {
      render(<EditableTitle value="Original title" onSave={() => {}} />);
      const pencil = screen.getByRole("button", { name: "Rename: Original title" });
      await userEvent.click(pencil);
      expect(screen.getByLabelText("Edit title")).toBeTruthy();

      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename: Original title" }));
    });

    it("restores focus to the pencil after a successful save", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(<ControlledEditableTitle initialValue="Original title" onSave={onSave} />);
      await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "New title{Enter}");

      const pencil = await screen.findByRole("button", { name: "Rename: New title" });
      expect(document.activeElement).toBe(pencil);
    });

    it("restores focus to the pencil after a failed save (alongside the reverted title and inline error)", async () => {
      const onSave = vi.fn().mockRejectedValue(new Error("Title already in use"));
      render(<EditableTitle value="Original title" onSave={onSave} />);
      await userEvent.click(screen.getByRole("button", { name: "Rename: Original title" }));

      const input = screen.getByLabelText("Edit title");
      await userEvent.clear(input);
      await userEvent.type(input, "Attempted new title{Enter}");

      const pencil = await screen.findByRole("button", { name: "Rename: Original title" });
      expect(document.activeElement).toBe(pencil);
      expect(screen.getByRole("alert").textContent).toBe("Title already in use");
    });
  });
});

/* --------------------------------------------------------------------------
   #310: the two discoverability defects in rename mode.
   -------------------------------------------------------------------------- */
describe("EditableTitle limit and keybinding disclosure (#310)", () => {
  it("does not clamp typing silently -- the value can exceed the limit", async () => {
    render(<EditableTitle value="Original" onSave={vi.fn()} maxLength={10} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original" }));
    const input = screen.getByLabelText("Edit title") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "far too long to fit");
    // The native maxLength attribute stopped accepting characters with no
    // signal, which reads as a broken field. Refusing on save with a
    // visible reason is the honest version.
    expect(input.value).toBe("far too long to fit");
    expect(input.getAttribute("maxlength")).toBeNull();
  });

  it("stays quiet on a short title and speaks up near the limit", async () => {
    render(<EditableTitle value="Original" onSave={vi.fn()} maxLength={100} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original" }));
    // 8 characters of 100 -- a counter here would be noise.
    expect(screen.queryByText(/left$/)).toBeNull();

    const input = screen.getByLabelText("Edit title") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "x".repeat(85));
    expect(screen.getByText("15 left")).toBeTruthy();
  });

  it("says how far over the limit the student is, rather than truncating", async () => {
    render(<EditableTitle value="Original" onSave={vi.fn()} maxLength={10} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original" }));
    const input = screen.getByLabelText("Edit title") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "x".repeat(13));
    expect(screen.getByText("3 over")).toBeTruthy();
  });

  it("discloses the keybindings, including that blur saves", async () => {
    render(<EditableTitle value="Original" onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename: Original" }));
    // Enter saves, Escape cancels, blur also saves -- three conventions
    // that had no discoverable surface at all.
    expect(screen.getByText(/enter/i)).toBeTruthy();
    expect(screen.getByText(/esc to cancel/i)).toBeTruthy();
  });
});
