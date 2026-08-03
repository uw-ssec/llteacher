// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileEditForm } from "./ProfileEditForm";

afterEach(cleanup);

describe("ProfileEditForm", () => {
  it("calls onSave with the edited display name", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProfileEditForm initialDisplayName="Cordero" onSave={onSave} />);

    const input = screen.getByLabelText("Display name");
    await userEvent.clear(input);
    await userEvent.type(input, "New Name");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onSave).toHaveBeenCalledWith("New Name");
  });

  it("disables the input and shows a saving state while the save is in flight", async () => {
    let resolveSave: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<ProfileEditForm initialDisplayName="Cordero" onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect((screen.getByLabelText("Display name") as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: /saving/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    resolveSave();
    await waitFor(() =>
      expect((screen.getByLabelText("Display name") as HTMLInputElement).disabled).toBe(false),
    );
  });
});
