// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopNav } from "./TopNav";

afterEach(cleanup);

function renderAuthed(overrides: Partial<Parameters<typeof TopNav>[0]> = {}) {
  return render(
    <TopNav
      course="STATS 311"
      term="Autumn 2026"
      homework="HW 3"
      userInitials="AC"
      isAuthenticated
      onProfileClick={() => {}}
      onLogout={() => {}}
      {...overrides}
    />,
  );
}

describe("TopNav account menu", () => {
  it("opens on click and reaches every item via Tab", async () => {
    renderAuthed();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));

    expect(screen.getByText("Profile")).toBeTruthy();
    expect(screen.getByText("Log out")).toBeTruthy();

    await userEvent.tab();
    expect(screen.getByText("Profile")).toBe(document.activeElement);
    await userEvent.tab();
    expect(screen.getByText("Log out")).toBe(document.activeElement);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    renderAuthed();
    const trigger = screen.getByRole("button", { name: "Account menu" });
    await userEvent.click(trigger);
    expect(screen.getByText("Profile")).toBeTruthy();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByText("Profile")).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  it("closes on an outside click", async () => {
    renderAuthed();
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByText("Profile")).toBeTruthy();

    await userEvent.click(document.body);

    expect(screen.queryByText("Profile")).toBeNull();
  });

  it("activating an item closes the menu", async () => {
    const onProfileClick = vi.fn();
    renderAuthed({ onProfileClick });
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByText("Profile"));

    expect(onProfileClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Profile")).toBeNull();
  });

  it("marks the trigger's popup state via aria-expanded only -- no aria-haspopup, no menu role", async () => {
    renderAuthed();
    const trigger = screen.getByRole("button", { name: "Account menu" });
    // aria-haspopup maps to "menu pop-up button" and promises an arrow-key
    // model this 2-item disclosure doesn't implement -- must stay absent.
    expect(trigger.hasAttribute("aria-haspopup")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("TopNav course switcher", () => {
  it("renders real course options and reports the selected course", async () => {
    const onCourseChange = vi.fn();
    renderAuthed({
      course: "STAT 311",
      term: "Autumn 2026",
      courseOptions: [
        { id: "course-a", label: "STAT 311 · Autumn 2026" },
        { id: "course-b", label: "BIO 180 · Winter 2027" },
      ],
      selectedCourseId: "course-a",
      onCourseChange,
    });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Current course" }), "course-b");
    expect(onCourseChange).toHaveBeenCalledWith("course-b");
  });
});
