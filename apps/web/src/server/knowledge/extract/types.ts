export type ExtractionOutcome =
  | { kind: "extracted"; type: string; title: string; markdown: string }
  | { kind: "unsupported"; reason: string };

export type Extractor = (filename: string, bytes: ArrayBuffer) => Promise<ExtractionOutcome>;

/** Ceiling on a single zip entry's *decompressed* size that docx/pptx
 *  extractors will read. Guards against a zip bomb: a small compressed file
 *  that expands to gigabytes when unzipped. */
export const MAX_PART_BYTES = 50 * 1024 * 1024;

export function titleFromFilename(filename: string): string {
  return filename.split("/").pop()!.replace(/\.[^.]+$/, "").trim() || "Untitled";
}

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}
