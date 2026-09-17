import { parseFrontmatter } from "../frontmatter";
import { titleFromFilename, type ExtractionOutcome } from "./types";

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

/** A file is a transcript when any of its first 40 lines is a cue timing
 *  line. Extension is not consulted: the surveyed course saved SRT as .txt. */
export function sniffTranscript(text: string): boolean {
  return text.split(/\r?\n/, 40).some((line) => TIMESTAMP_RE.test(line));
}

export async function extractText(filename: string, bytes: ArrayBuffer): Promise<ExtractionOutcome> {
  let text = new TextDecoder().decode(bytes);
  let title = titleFromFilename(filename);
  let type = "note";
  let description: string | undefined;
  if (/\.md$/i.test(filename)) {
    const parsed = parseFrontmatter(text);
    // Import metadata as metadata, rather than feeding a second YAML header
    // to retrieval or using its delimiters as the generated description.
    if (Object.keys(parsed.frontmatter).length > 0) {
      text = parsed.body;
      title = parsed.frontmatter.title || title;
      type = parsed.frontmatter.type || type;
      description = parsed.frontmatter.description;
    }
  }
  if (sniffTranscript(text)) {
    return { kind: "extracted", type: "transcript", title, markdown: transcriptToProse(text) };
  }
  return { kind: "extracted", type, title, ...(description ? { description } : {}), markdown: text.trim() };
}
