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

  /* The four cases below are regressions. The first two were silently deleting
     an instructor's words: a bare /-->/ test matched a spoken "A --> B", and
     /^\d+$/ matched a cue whose entire spoken text was a number. Losing a
     lecturer's sentence is a far worse failure than keeping a stray timestamp,
     so these pin the direction as much as the behaviour. */

  it("keeps a spoken line that happens to contain an arrow", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nthe process goes A --> B";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("the process goes A --> B");
  });

  it("keeps a spoken line that is only a number", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\n42\n\n2\n00:00:04,000 --> 00:00:07,000\nThat was the answer.";
    expect(convertToOkf("a.srt", bytes(srt))?.markdown).toBe("42\n\nThat was the answer.");
  });

  it("drops WebVTT NOTE blocks rather than reading them as speech", () => {
    const vtt = "WEBVTT\n\nNOTE a translator comment\n\n00:00:01.000 --> 00:00:04.000\nWelcome.";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Welcome.");
  });

  it("drops a named WebVTT cue identifier, not just a numeric one", () => {
    const vtt = "WEBVTT\n\nintro\n00:00:01.000 --> 00:00:04.000\nWelcome.";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Welcome.");
  });

  /* Additional boundary cases beyond the plan's regression set, added while
     fixing this module -- the review's core lesson was that the plan's own
     tests shared its blind spots, so these probe past what it thought to
     check rather than just re-confirming it. */

  it("recognises a non-numeric SRT cue identifier structurally, not by shape", () => {
    // Real SRT cue ids are numeric by convention, but transcriptToProse does
    // not know or care which subtitle format it is reading -- it only looks
    // at what sits above a timing line. A stray non-numeric id must not be
    // read as spoken text.
    const srt =
      "cue-a\n00:00:01,000 --> 00:00:04,000\nFirst line.\n\ncue-b\n00:00:04,000 --> 00:00:07,000\nSecond line.";
    expect(convertToOkf("talk.srt", bytes(srt))?.markdown).toBe(
      "First line.\n\nSecond line.",
    );
  });

  it("joins a cue's multiple text lines into one paragraph", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nLine one.\nLine two.";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Line one. Line two.");
  });

  it("handles a WebVTT file with no blank line after the header", () => {
    // The header-stripping step only looks at the first line of whichever
    // block it lands in; it must not assume a blank line always separates
    // WEBVTT from the first cue.
    const vtt = "WEBVTT\n00:00:01.000 --> 00:00:04.000\nHello.";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe("Hello.");
  });

  it("keeps prose that merely starts with NOTE-like text but has no timing line", () => {
    // METADATA_BLOCK_RE uses \b so it must not fire on a word that only
    // shares a prefix with NOTE/STYLE/REGION -- otherwise real instructor
    // speech beginning with those letters would be silently dropped, the
    // exact failure mode this whole fix round is about.
    const vtt = "WEBVTT\n\nNOTES from today's guest speaker.\nWelcome them warmly.";
    expect(convertToOkf("a.vtt", bytes(vtt))?.markdown).toBe(
      "NOTES from today's guest speaker. Welcome them warmly.",
    );
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
