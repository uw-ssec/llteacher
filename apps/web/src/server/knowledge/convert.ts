/* --------------------------------------------------------------------------
   Tier-1 ingestion: the conversions that need no model (#42).

   #40 owns extraction from binary formats. This file owns the formats where
   "extraction" is string handling -- and it exists so that the upload path
   is genuinely end-to-end for at least one real instructor use case
   (lecture transcripts) rather than being a stub that stores bytes and
   reports a status nobody can act on.

   convertToOkf returns null for pdf/docx/pptx, and the caller holds those at
   status 'pending' with an explicit note. Nothing here ever produces a
   document that claims to be ready when no text was extracted.
   -------------------------------------------------------------------------- */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const ALLOWED_EXTENSIONS = [
  "pdf",
  "docx",
  "pptx",
  "txt",
  "md",
  "vtt",
  "srt",
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export interface ConversionResult {
  /** The OKF `type` frontmatter value — the one always-required key. */
  type: string;
  title: string;
  markdown: string;
}

export function extensionOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** Maps to the existing material_source_type enum. `md`/`txt`/`docx` have no
 *  dedicated member, so they land on `other` rather than growing the enum
 *  for a distinction nothing branches on. */
export function sourceTypeFor(
  filename: string,
): "pdf" | "slides" | "transcript" | "syllabus" | "other" {
  switch (extensionOf(filename)) {
    case "pdf":
      return "pdf";
    case "pptx":
      return "slides";
    case "vtt":
    case "srt":
      return "transcript";
    default:
      return "other";
  }
}

/** A real cue-timing line, anchored at line start: `00:00:01.000 --> 00:00:04.000`
 *  with optional hours and optional trailing cue settings. WebVTT uses `.` for
 *  the fraction, SubRip uses `,`.
 *
 *  Anchoring is the whole point. A bare /-->/ test also matches an instructor
 *  SAYING "the process goes A --> B", and that sentence was being deleted from
 *  the transcript with no error and no trace. Dropping a lecturer's words is a
 *  far worse failure than keeping a stray timestamp, so this errs toward
 *  keeping text. */
const TIMESTAMP_RE =
  /^\s*(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

/** WebVTT blocks that are metadata, not speech. Their contents are notes,
 *  styling, or region definitions and must not reach the prose. */
const METADATA_BLOCK_RE = /^(?:NOTE|STYLE|REGION)\b/;

/** WebVTT speaker voice spans: <v Sara>text</v>. */
const VOICE_RE = /<\/?v[^>]*>/g;

/** Both WebVTT and SubRip are blocks of: an OPTIONAL cue identifier, a timing
 *  line, then the spoken text.
 *
 *  A cue identifier is recognised STRUCTURALLY -- it is whatever sits directly
 *  above a timing line -- rather than by pattern. Matching /^\d+$/ instead was
 *  deleting a cue whose entire spoken text was a number ("42"), and it could
 *  never have handled WebVTT's named identifiers at all. Position identifies a
 *  cue id; shape does not. */
function transcriptToProse(raw: string): string {
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const paragraphs: string[] = [];

  for (const block of blocks) {
    let lines = block.split("\n").map((line) => line.trim()).filter((l) => l !== "");
    if (lines.length === 0) continue;

    // The file header, with or without a title: `WEBVTT` / `WEBVTT - Lecture 1`.
    if (/^WEBVTT\b/.test(lines[0])) lines = lines.slice(1);
    if (lines.length === 0) continue;

    // NOTE / STYLE / REGION blocks are metadata; drop the whole block.
    if (METADATA_BLOCK_RE.test(lines[0])) continue;

    // Strip the timing line, plus a cue identifier if one sits above it.
    if (TIMESTAMP_RE.test(lines[0])) {
      lines = lines.slice(1);
    } else if (lines.length > 1 && TIMESTAMP_RE.test(lines[1])) {
      lines = lines.slice(2);
    }

    const text = lines
      .map((line) => line.replace(VOICE_RE, "").trim())
      .filter((line) => line !== "");

    if (text.length > 0) paragraphs.push(text.join(" "));
  }

  return paragraphs.join("\n\n");
}

export function convertToOkf(
  filename: string,
  bytes: ArrayBuffer,
): ConversionResult | null {
  const extension = extensionOf(filename);
  const title = filename.replace(/\.[^.]+$/, "");

  switch (extension) {
    case "vtt":
    case "srt":
      return {
        type: "transcript",
        title,
        markdown: transcriptToProse(new TextDecoder().decode(bytes)),
      };
    case "md":
    case "txt":
      return {
        type: "note",
        title,
        markdown: new TextDecoder().decode(bytes).trim(),
      };
    default:
      // pdf, docx, pptx: #40's job. Deliberately not a throw -- an
      // un-extractable upload is a normal outcome, not an error.
      return null;
  }
}
