import { describe, it, expect } from "vitest";
import { convertToOkf, sourceTypeFor, MAX_UPLOAD_BYTES } from "./convert";

const bytes = (s: string) => new TextEncoder().encode(s).buffer;

describe("convertToOkf", () => {
  it("converts a WebVTT transcript to prose", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Welcome to lecture one.

00:00:04.000 --> 00:00:07.000
Today we cover regression.`;
    const result = convertToOkf("lecture1.vtt", bytes(vtt));
    expect(result).toEqual({
      type: "transcript",
      title: "lecture1",
      markdown: "Welcome to lecture one.\n\nToday we cover regression.",
    });
  });

  it("converts an SRT transcript, dropping cue numbers", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
First line.

2
00:00:04,000 --> 00:00:07,000
Second line.`;
    expect(convertToOkf("talk.srt", bytes(srt))?.markdown).toBe("First line.\n\nSecond line.");
  });

  it("drops WebVTT speaker tags and cue settings", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000 align:start\n<v Sara>Hello.</v>";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Hello.");
  });

  it("passes markdown through unchanged", () => {
    expect(convertToOkf("notes.md", bytes("# Title\n\nBody."))).toEqual({
      type: "note",
      title: "notes",
      markdown: "# Title\n\nBody.",
    });
  });

  it("treats plain text as a note", () => {
    expect(convertToOkf("syllabus.txt", bytes("Week 1"))?.type).toBe("note");
  });

  it("returns null for formats the pipeline cannot extract yet", () => {
    expect(convertToOkf("paper.pdf", bytes("%PDF-1.7"))).toBeNull();
    expect(convertToOkf("deck.pptx", bytes("PK"))).toBeNull();
    expect(convertToOkf("doc.docx", bytes("PK"))).toBeNull();
  });
});

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
