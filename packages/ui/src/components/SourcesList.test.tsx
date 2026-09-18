// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SourcesList } from "./SourcesList";

afterEach(cleanup);

describe("SourcesList", () => {
  it("renders nothing for no sources", () => {
    const { container } = render(<SourcesList sources={[]} />);
    expect(container.firstChild).toBeNull();
  });
  it("renders a collapsed list with a count and each title", () => {
    render(<SourcesList sources={[{ conceptId: "lectures/intro", title: "Intro" }, { conceptId: "syllabus", title: "Syllabus" }]} />);
    expect(screen.getByText("Sources (2)")).toBeTruthy();
    expect(screen.getByText("Intro")).toBeTruthy();
    expect(screen.getByText("lectures/intro")).toBeTruthy();
    expect(screen.getByRole("group").hasAttribute("open")).toBe(false);
  });
});
