import { describe, it, expect } from "vitest";
import { sourceTypeFor, MAX_UPLOAD_BYTES } from "./convert";

describe("sourceTypeFor", () => {
  it.each([
    ["a.pdf", "pdf"],
    ["a.pptx", "slides"],
    ["a.vtt", "transcript"],
    ["a.srt", "transcript"],
    ["a.md", "other"],
    ["a.docx", "other"],
  ])("maps %s to %s", (filename, expected) => {
    expect(sourceTypeFor(filename)).toBe(expected);
  });
});

it("caps uploads at 25 MB", () => {
  expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
});
