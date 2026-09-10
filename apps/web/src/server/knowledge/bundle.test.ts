import { describe, it, expect } from "vitest";
import { appendLogEntry, directoryOf, parentDirectories, renderIndex } from "./bundle";
import { parseLinks } from "./parseLinks";

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

  // M-8 / final review deferred item 14 (triaged fix-before-merge): a title
  // containing `]` used to be interpolated straight into the link label
  // unescaped, producing `* [Part 1] Notes](/week1/a)` -- a malformed link
  // whose own `]` closes the label three characters early. This pins that
  // the literal character never reaches the rendered label.
  it("does not let a title's own ] characters break the link syntax", () => {
    const markdown = renderIndex("week1", [
      { path: "week1/a", title: "Part 1] Notes", description: null },
    ]);
    expect(markdown).not.toContain("[Part 1] Notes](/week1/a)");
    expect(markdown).toContain("[Part 1］ Notes](/week1/a)");
  });

  // The real failure mode M-8 describes is one level removed from the
  // string shape above: the malformed entry is then fed back through
  // parseLinks (index.md is itself a document with a body). Pre-fix, that
  // second parse would either extract no link from this line at all (the
  // trailing "] Notes](/week1/a)" has no leading "[" to anchor a new match)
  // or -- worse, depending on surrounding content -- misattribute the link
  // boundary. Either way `week1/a` is not the link target the source data
  // says it should be. This asserts the round trip actually holds.
  it("round-trips through parseLinks even when a title contains ]", () => {
    const markdown = renderIndex("week1", [
      { path: "week1/a", title: "Part 1] Notes", description: null },
    ]);
    const links = parseLinks(markdown, "week1/index");
    expect(links.map((l) => l.targetPath)).toContain("week1/a");
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
