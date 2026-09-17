/* Regression coverage for transcriptToProse's cue-parsing edge cases (text.ts),
 * ported from the now-deleted convertToOkf tests in convert.test.ts (see
 * `git show d9aeebe:apps/web/src/server/knowledge/convert.test.ts`).
 *
 * convertToOkf used to branch on file extension: .vtt/.srt always ran through
 * transcriptToProse regardless of content. That branching now lives inside
 * extractText (text.ts) via sniffTranscript: a file is treated as a
 * transcript only when it actually contains a cue-timing line, txt/md/vtt/srt
 * alike. These tests are adapted to call extract(filename, bytes) from
 * ./index accordingly -- most fixtures are unaffected because they already
 * contain a real timing line, but the "NOTE-like prose with no timing line"
 * case now demonstrably falls through to a plain note instead of being run
 * through cue stripping, which is the new, correct behaviour. */
import { describe, it, expect } from "vitest";
import { extract } from "./index";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("extract: transcript prose conversion", () => {
  it("converts a full WebVTT transcript to prose", async () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Welcome to lecture one.

00:00:04.000 --> 00:00:07.000
Today we cover regression.`;
    const out = await extract("lecture1.vtt", enc(vtt));
    expect(out).toEqual({
      kind: "extracted",
      type: "transcript",
      title: "lecture1",
      markdown: "Welcome to lecture one.\n\nToday we cover regression.",
    });
  });

  it("handles a WebVTT file with no blank line after the header", async () => {
    // The header-stripping step only looks at the first line of whichever
    // block it lands in; it must not assume a blank line always separates
    // WEBVTT from the first cue.
    const vtt = "WEBVTT\n00:00:01.000 --> 00:00:04.000\nHello.";
    const out = await extract("a.vtt", enc(vtt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("Hello.");
  });

  it("drops WebVTT NOTE blocks rather than reading them as speech", async () => {
    const vtt = "WEBVTT\n\nNOTE a translator comment\n\n00:00:01.000 --> 00:00:04.000\nWelcome.";
    const out = await extract("a.vtt", enc(vtt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("Welcome.");
  });

  it("keeps prose that merely starts with NOTE-like text but has no timing line, as a plain note", async () => {
    // With no cue-timing line anywhere in the file, sniffTranscript correctly
    // classifies this as a note rather than a transcript, so it is never run
    // through transcriptToProse at all -- it passes through unchanged. This
    // is the new architecture's answer to the same underlying concern the
    // old METADATA_BLOCK_RE \b-boundary test pinned: a word that only shares
    // a prefix with NOTE/STYLE/REGION must never cause real content to be
    // silently dropped.
    const vtt = "WEBVTT\n\nNOTES from today's guest speaker.\nWelcome them warmly.";
    const out = await extract("a.vtt", enc(vtt));
    expect(out).toMatchObject({ kind: "extracted", type: "note" });
    expect((out as { markdown: string }).markdown).toBe(vtt);
  });

  it("drops a named WebVTT cue identifier, not just a numeric one", async () => {
    const vtt = "WEBVTT\n\nintro\n00:00:01.000 --> 00:00:04.000\nWelcome.";
    const out = await extract("a.vtt", enc(vtt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("Welcome.");
  });

  it("recognises a non-numeric SRT cue identifier structurally, not by shape", async () => {
    // Real SRT cue ids are numeric by convention, but transcriptToProse does
    // not know or care which subtitle format it is reading -- it only looks
    // at what sits above a timing line. A stray non-numeric id must not be
    // read as spoken text.
    const srt =
      "cue-a\n00:00:01,000 --> 00:00:04,000\nFirst line.\n\ncue-b\n00:00:04,000 --> 00:00:07,000\nSecond line.";
    const out = await extract("talk.srt", enc(srt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("First line.\n\nSecond line.");
  });

  it("drops WebVTT speaker tags and cue settings", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000 align:start\n<v Sara>Hello.</v>";
    const out = await extract("a.vtt", enc(vtt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("Hello.");
  });

  it("keeps a spoken line that happens to contain an arrow", async () => {
    // A bare /-->/ test also matches an instructor SAYING "the process goes
    // A --> B", and that sentence was being deleted from the transcript with
    // no error and no trace. Losing a lecturer's words is a far worse
    // failure than keeping a stray timestamp.
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nthe process goes A --> B";
    const out = await extract("a.vtt", enc(vtt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("the process goes A --> B");
  });

  it("keeps a spoken line that is only a number", async () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\n42\n\n2\n00:00:04,000 --> 00:00:07,000\nThat was the answer.";
    const out = await extract("a.srt", enc(srt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("42\n\nThat was the answer.");
  });

  it("joins a cue's multiple text lines into one paragraph", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nLine one.\nLine two.";
    const out = await extract("a.vtt", enc(vtt));
    expect(out).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((out as { markdown: string }).markdown).toBe("Line one. Line two.");
  });

  it("produces the same prose for CRLF line endings as for LF", async () => {
    const lf = "1\n00:00:01,000 --> 00:00:04,000\nFirst line.\n\n2\n00:00:04,000 --> 00:00:07,000\nSecond line.";
    const crlf = lf.replace(/\n/g, "\r\n");
    const [lfOut, crlfOut] = await Promise.all([
      extract("talk.srt", enc(lf)),
      extract("talk-crlf.srt", enc(crlf)),
    ]);
    expect(lfOut).toMatchObject({ kind: "extracted", type: "transcript" });
    expect((lfOut as { markdown: string }).markdown).toBe("First line.\n\nSecond line.");
    expect((crlfOut as { markdown: string }).markdown).toBe((lfOut as { markdown: string }).markdown);
  });
});


describe("Markdown imports", () => {
  it("keeps title/type/description but excludes frontmatter from the body", async () => {
    const out = await extract("gdp.md", enc('---\ntype: lecture\ntitle: "GDP"\ndescription: "Final goods and services"\nresource: "file:///private/source.pptx"\n---\n\n# GDP\nFinal output.'));
    expect(out).toEqual({ kind: "extracted", type: "lecture", title: "GDP", description: "Final goods and services", markdown: "# GDP\nFinal output." });
  });
});
