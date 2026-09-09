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

  /* The two cases below are the ones the original splice implementation got
     wrong. They are latent while entries arrive in real time, and reachable the
     moment anything backfills a historical date. */

  it("files a middle date in order rather than assuming it is newest", () => {
    const existing =
      "# Log\n\n## 2026-09-09\n\nnewest.\n\n## 2026-09-07\n\noldest.\n";
    expect(appendLogEntry(existing, "2026-09-08", "middle.")).toBe(
      "# Log\n\n## 2026-09-09\n\nnewest.\n\n## 2026-09-08\n\nmiddle.\n\n## 2026-09-07\n\noldest.\n",
    );
  });

  it("keeps the blank line before the next heading when appending to a middle section", () => {
    const existing =
      "# Log\n\n## 2026-09-09\n\nfirst.\n\n## 2026-09-07\n\noldest.\n";
    const result = appendLogEntry(existing, "2026-09-09", "second.");
    expect(result).toContain("first.\nsecond.\n\n## 2026-09-07");
    // Malformed markdown would run the entry straight into the next heading.
    expect(result).not.toContain("second.\n## 2026-09-07");
  });

  /* Additional boundary cases beyond the plan's regression set, added while
     fixing this module. Parsing to sections and re-rendering means these
     should hold "for free", but that claim is worth pinning with tests
     rather than taking on faith. */

  it("normalises irregular spacing in the existing log", () => {
    // Extra blank lines and a heading with no blank line before its entry
    // must not survive into the output -- re-rendering from parsed
    // structure is supposed to make spacing hold by construction.
    const existing =
      "# Log\n\n\n## 2026-09-09\n\n\nfirst.\n\n\n## 2026-09-07\noldest.\n";
    expect(appendLogEntry(existing, "2026-09-09", "second.")).toBe(
      "# Log\n\n## 2026-09-09\n\nfirst.\nsecond.\n\n## 2026-09-07\n\noldest.\n",
    );
  });

  it("accumulates multiple appends to the same date across a three-section log", () => {
    const existing =
      "# Log\n\n## 2026-09-09\n\nfirst.\n\n## 2026-09-08\n\nmiddle.\n\n## 2026-09-07\n\noldest.\n";
    const once = appendLogEntry(existing, "2026-09-08", "second middle entry.");
    const twice = appendLogEntry(once, "2026-09-08", "third middle entry.");
    expect(twice).toBe(
      "# Log\n\n## 2026-09-09\n\nfirst.\n\n## 2026-09-08\n\nmiddle.\nsecond middle entry.\nthird middle entry.\n\n## 2026-09-07\n\noldest.\n",
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
