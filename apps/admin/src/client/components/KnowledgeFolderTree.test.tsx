// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { KnowledgeFolderTree } from "./KnowledgeFolderTree";
import { treeOf } from "../lib/documentTree";

afterEach(cleanup);

const ROOT = treeOf([
  { id: "1", path: "week1/lecture", kind: "concept", indexStatus: "indexed" },
  { id: "2", path: "week1/lab/notes", kind: "concept", indexStatus: "pending" },
  { id: "3", path: "syllabus", kind: "concept", indexStatus: "indexed" },
  { id: "4", path: "week2/index", kind: "index", indexStatus: "indexed" },
]);

function renderTree(over: Partial<React.ComponentProps<typeof KnowledgeFolderTree>> = {}) {
  const props = {
    root: ROOT,
    selected: "",
    expanded: new Set([""]),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onCollapseAll: vi.fn(),
    ...over,
  };
  render(<KnowledgeFolderTree {...props} />);
  return props;
}

describe("KnowledgeFolderTree", () => {
  it("shows only the children of expanded folders", () => {
    renderTree();
    expect(screen.getByRole("treeitem", { name: /week1/ })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /lab/ })).toBeNull();
  });

  it("reveals a folder's children once it is expanded", () => {
    renderTree({ expanded: new Set(["", "week1"]) });
    expect(screen.getByRole("treeitem", { name: /lab/ })).toBeTruthy();
  });

  it("toggles a folder from its chevron without selecting it", () => {
    const { onToggle, onSelect } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Expand week1" }));
    expect(onToggle).toHaveBeenCalledWith("week1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects a folder from its name", () => {
    const { onSelect } = renderTree();
    fireEvent.click(screen.getByRole("treeitem", { name: /week1/ }));
    expect(onSelect).toHaveBeenCalledWith("week1");
  });

  it("shows the recursive count and marks folders with documents needing attention", () => {
    renderTree();
    const week1 = screen.getByRole("treeitem", { name: /week1/ });
    expect(week1.textContent).toMatch(/2/);
    // The root and week1 both contain the pending document.
    expect(screen.getAllByTitle("1 needs attention")).toHaveLength(2);
    expect(screen.getByRole("treeitem", { name: /week2/ }).textContent).toMatch(/0/);
  });

  it("marks the selected folder", () => {
    renderTree({ selected: "week1" });
    expect(screen.getByRole("treeitem", { name: /week1/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /Knowledge base/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("offers Collapse all", () => {
    const { onCollapseAll } = renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(onCollapseAll).toHaveBeenCalled();
  });

  it("gives a folder with no subfolders no chevron", () => {
    renderTree();
    expect(screen.queryByRole("button", { name: /Expand week2/ })).toBeNull();
  });
});
