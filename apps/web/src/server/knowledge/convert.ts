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

const TIMESTAMP_RE = /-->/;
const CUE_NUMBER_RE = /^\d+$/;
/** WebVTT speaker voice spans: <v Sara>text</v>. */
const VOICE_RE = /<\/?v[^>]*>/g;

/** Both WebVTT and SubRip are: optional cue id, a timestamp line, then text,
 *  separated by blank lines. Dropping the machinery and keeping the text is
 *  the whole conversion. */
function transcriptToProse(raw: string): string {
  const blocks = raw.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const paragraphs: string[] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line !== "" &&
          line !== "WEBVTT" &&
          !TIMESTAMP_RE.test(line) &&
          !CUE_NUMBER_RE.test(line),
      )
      .map((line) => line.replace(VOICE_RE, "").trim())
      .filter((line) => line !== "");

    if (lines.length > 0) paragraphs.push(lines.join(" "));
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
