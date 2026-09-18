import { transcribePdf, type OcrOptions } from "./ocr";
import { extractText as unpdfExtract, getDocumentProxy } from "unpdf";
import { titleFromFilename, type ExtractionOutcome } from "./types";

/** Below this many characters per page the file is treated as a scan. */
const MIN_CHARS_PER_PAGE = 20;

export async function extractPdf(filename: string, bytes: ArrayBuffer, ocr?: OcrOptions): Promise<ExtractionOutcome> {
  let totalPages: number;
  let cleaned: string;
  try {
    // { verbosity: 0 } is passed through to pdf.js's getDocument() to try to
    // silence its "Indexing all PDF objects" stderr warning on minimal PDFs.
    const doc = await getDocumentProxy(new Uint8Array(bytes.slice(0)), { verbosity: 0 });
    try {
      const { totalPages: count, text } = await unpdfExtract(doc, { mergePages: true });
      totalPages = count;
      cleaned = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    } finally {
      await doc.loadingTask.destroy();
    }
  } catch {
    return { kind: "unsupported", reason: "PDF could not be parsed" };
  }
  if (totalPages === 0 || cleaned.length < MIN_CHARS_PER_PAGE * Math.max(1, totalPages) / 4) {
    if (!ocr) return { kind: "unsupported", reason: "PDF has no text layer; OCR is not configured" };
    cleaned = await transcribePdf(bytes, totalPages, ocr);
  }
  return { kind: "extracted", type: "reading", title: titleFromFilename(filename), markdown: cleaned };
}
