import { describe, it, expect } from "vitest";
import { isValidConceptId, slugSegment, conceptIdFromUpload } from "./conceptId";

describe("isValidConceptId", () => {
  it.each(["lectures/module-1/intro", "syllabus", "a/b/c-d-9"])("accepts %s", (id) => {
    expect(isValidConceptId(id)).toBe(true);
  });
  it.each(["Bad Id", "../escape", "/lead", "a//b", "a/./b", "index", "x/log", "a.b", ""])(
    "rejects %s",
    (id) => expect(isValidConceptId(id)).toBe(false),
  );
});

describe("slugSegment", () => {
  it("lowercases and hyphenates", () => {
    expect(slugSegment("Uploaded Lectures")).toBe("uploaded-lectures");
    expect(slugSegment("Module 1 (Intro).docx")).toBe("module-1-intro-docx");
    expect(slugSegment("---")).toBe("untitled");
  });
});

describe("conceptIdFromUpload", () => {
  it("mirrors the folder tree and drops the extension", () => {
    expect(conceptIdFromUpload("Uploaded Lectures/Module 1/Lecture 2.docx", "Lecture 2.docx")).toBe(
      "uploaded-lectures/module-1/lecture-2",
    );
  });
  it("uses only the filename when there is no relative path", () => {
    expect(conceptIdFromUpload(null, "Syllabus.pdf")).toBe("syllabus");
  });
  it("renames reserved basenames", () => {
    expect(conceptIdFromUpload(null, "index.txt")).toBe("index-material");
  });
});
