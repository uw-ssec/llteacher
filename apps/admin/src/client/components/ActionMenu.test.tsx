// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ActionMenu } from "./ActionMenu";

afterEach(cleanup);

function renderMenu(over: Partial<React.ComponentProps<typeof ActionMenu>> = {}) {
  const onClean = vi.fn();
  render(
    <ActionMenu
      label="More actions"
      items={[
        { kind: "action", label: "Clean up Markdown", hint: "AI", onSelect: onClean },
        { kind: "group", label: "Download" },
        { kind: "link", label: "Markdown", hint: ".md", href: "/api/x/download", download: "lecture.md" },
      ]}
      {...over}
    />,
  );
  return { onClean };
}

describe("ActionMenu", () => {
  it("is closed until its button is pressed, then lists the items", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "More actions" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menuitem", { name: /Clean up Markdown/ })).toBeTruthy();
  });

  it("runs an action and closes", () => {
    const { onClean } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Clean up Markdown/ }));
    expect(onClean).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders a link item as a real download link", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const link = screen.getByRole("menuitem", { name: /^Markdown/ }) as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/api/x/download");
    expect(link.getAttribute("download")).toBe("lecture.md");
  });

  it("closes on Escape and returns focus to the button", () => {
    renderMenu();
    const trigger = screen.getByRole("button", { name: "More actions" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus between items with the arrow keys", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("closes when something outside it is clicked", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables an action that is not currently possible", () => {
    render(<ActionMenu label="More actions" items={[{ kind: "action", label: "Restore original", onSelect: vi.fn(), disabled: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect((screen.getByRole("menuitem", { name: /Restore original/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
