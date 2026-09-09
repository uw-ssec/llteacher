import { describe, it, expect } from "vitest";
import { appendLogEntry, directoryOf, parentDirectories, renderIndex } from "./bundle";

describe("renderIndex", () => {
  it("renders OKF index entries under a heading", () => {
    const markdown = renderIndex("week1", [
      { path: "week1/a", title: "Alpha", description: "First." },
      { path: "week1/b", title: null, description: null },
    ]);
    expect(markdown).toBe(
      "## week1\n\n* [Alpha](/week1/a) - First.\n* [b](/week1/b)\n",
    );
  });

  it("names the root heading rather than printing an empty one", () => {
    expect(renderIndex("", [{ path: "a", title: "A", description: null }])).toBe(
      "## Knowledge base\n\n* [A](/a)\n",
    );
  });

  it("renders an empty directory without an entry list", () => {
    expect(renderIndex("week1", [])).toBe("## week1\n\nNo documents yet.\n");
  });
});

describe("appendLogEntry", () => {
  it("creates the log with a dated heading", () => {
    expect(appendLogEntry("", "2026-09-09", "**Creation** Added week1/a.")).toBe(
      "# Log\n\n## 2026-09-09\n\n**Creation** Added week1/a.\n",
    );
  });

  it("adds to today's existing heading rather than duplicating it", () => {
    const existing = "# Log\n\n## 2026-09-09\n\n**Creation** Added a.\n";
    expect(appendLogEntry(existing, "2026-09-09", "**Update** Edited a.")).toBe(
      "# Log\n\n## 2026-09-09\n\n**Creation** Added a.\n**Update** Edited a.\n",
    );
  });

  it("puts a new date above older ones, newest first", () => {
    const existing = "# Log\n\n## 2026-09-08\n\n**Creation** Added a.\n";
    expect(appendLogEntry(existing, "2026-09-09", "**Update** Edited a.")).toBe(
      "# Log\n\n## 2026-09-09\n\n**Update** Edited a.\n\n## 2026-09-08\n\n**Creation** Added a.\n",
    );
  });
});

describe("directoryOf / parentDirectories", () => {
  it("returns the containing directory", () => {
    expect(directoryOf("a/b/c")).toBe("a/b");
    expect(directoryOf("a")).toBe("");
  });

  it("lists every ancestor directory, root first", () => {
    expect(parentDirectories("a/b/c")).toEqual(["", "a", "a/b"]);
    expect(parentDirectories("a")).toEqual([""]);
  });
});
