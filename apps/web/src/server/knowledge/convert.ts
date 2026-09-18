/* --------------------------------------------------------------------------
   Upload validation constants and small filename helpers (#42).

   Text extraction itself (including transcript-to-prose conversion) now
   lives under knowledge/extract/ (#40); this file keeps only what the
   upload route needs before bytes are ever read: the allowed extensions,
   the size cap, and the source-type/extension helpers.
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
