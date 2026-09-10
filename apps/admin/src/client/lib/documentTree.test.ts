import { describe, it, expect } from "vitest";
import { directoriesOf, documentsIn, directoryOf, depthOf, nameOf } from "./documentTree";

const DOCS = [
  { id: "1", path: "index", kind: "index" as const },
  { id: "2", path: "week1/index", kind: "index" as const },
  { id: "3", path: "week1/lecture", kind: "concept" as const },
  { id: "4", path: "week1/lab/notes", kind: "concept" as const },
  { id: "5", path: "syllabus", kind: "concept" as const },
];

describe("directoriesOf", () => {
  it("derives every directory from paths, root first", () => {
    expect(directoriesOf(DOCS)).toEqual(["", "week1", "week1/lab"]);
  });

  it("returns just the root for a flat bundle", () => {
    expect(directoriesOf([{ id: "1", path: "a", kind: "concept" }])).toEqual([""]);
  });

  it("returns just the root for an entirely empty bundle", () => {
    expect(directoriesOf([])).toEqual([""]);
  });

  it("derives every intermediate directory for a deeply nested path", () => {
    const deep = [{ id: "1", path: "a/b/c/d/e/concept", kind: "concept" as const }];
    expect(directoriesOf(deep)).toEqual(["", "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e"]);
  });

  it("does not confuse a directory with a sibling whose name it prefixes", () => {
    const docs = [
      { id: "1", path: "week1/a", kind: "concept" as const },
      { id: "2", path: "week10/b", kind: "concept" as const },
      { id: "3", path: "week1/c/d", kind: "concept" as const },
    ];
    expect(directoriesOf(docs)).toEqual(["", "week1", "week1/c", "week10"]);
  });

  it("includes a folder created by an index document but not yet filled with concepts", () => {
    const docs = [{ id: "1", path: "week2/index", kind: "index" as const }];
    expect(directoriesOf(docs)).toEqual(["", "week2"]);
  });
});

describe("documentsIn", () => {
  it("lists a directory's own concepts, not its descendants'", () => {
    expect(documentsIn(DOCS, "week1").map((d) => d.path)).toEqual(["week1/lecture"]);
  });

  it("lists root concepts", () => {
    expect(documentsIn(DOCS, "").map((d) => d.path)).toEqual(["syllabus"]);
  });

  it("hides index and log documents — they are structure, not content", () => {
    expect(documentsIn(DOCS, "week1").every((d) => d.kind === "concept")).toBe(true);
  });

  it("returns nothing for an empty bundle", () => {
    expect(documentsIn([], "")).toEqual([]);
  });

  it("does not leak a sibling's documents when one directory name prefixes another", () => {
    const docs = [
      { id: "1", path: "week1/a", kind: "concept" as const },
      { id: "2", path: "week10/b", kind: "concept" as const },
    ];
    expect(documentsIn(docs, "week1").map((d) => d.path)).toEqual(["week1/a"]);
    expect(documentsIn(docs, "week10").map((d) => d.path)).toEqual(["week10/b"]);
  });

  it("finds a document at the bottom of a deeply nested path", () => {
    const docs = [{ id: "1", path: "a/b/c/d/e/concept", kind: "concept" as const }];
    expect(documentsIn(docs, "a/b/c/d/e").map((d) => d.path)).toEqual(["a/b/c/d/e/concept"]);
    expect(documentsIn(docs, "a/b/c/d")).toEqual([]);
  });

  it("excludes log documents from a directory listing", () => {
    const docs = [
      { id: "1", path: "week1/changes", kind: "log" as const },
      { id: "2", path: "week1/lecture", kind: "concept" as const },
    ];
    expect(documentsIn(docs, "week1").map((d) => d.path)).toEqual(["week1/lecture"]);
  });
});

describe("directoryOf", () => {
  it("returns the empty string for a root-level path", () => {
    expect(directoryOf("syllabus")).toBe("");
  });

  it("returns the full parent chain for a nested path", () => {
    expect(directoryOf("a/b/c/d")).toBe("a/b/c");
  });
});

describe("depthOf", () => {
  it("is 0 for the root", () => {
    expect(depthOf("")).toBe(0);
  });

  it("counts segments for a nested directory", () => {
    expect(depthOf("a/b/c")).toBe(3);
  });
});

describe("nameOf", () => {
  it("labels the root as Knowledge base", () => {
    expect(nameOf("")).toBe("Knowledge base");
  });

  it("uses the last segment as the name", () => {
    expect(nameOf("week1/lab")).toBe("lab");
  });
});
