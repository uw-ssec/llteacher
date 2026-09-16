import { extractText as unpdfExtract, getDocumentProxy } from "unpdf";
import { titleFromFilename, type ExtractionOutcome } from "./types";

/** Below this many characters per page the file is treated as a scan. */
const MIN_CHARS_PER_PAGE = 20;

export async function extractPdf(filename: string, bytes: ArrayBuffer): Promise<ExtractionOutcome> {
  try {
    // { verbosity: 0 } is passed through to pdf.js's getDocument() to try to
    // silence its "Indexing all PDF objects" stderr warning on minimal PDFs.
    const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    const { totalPages, text } = await unpdfExtract(doc, { mergePages: true });
    const cleaned = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (totalPages === 0 || cleaned.length < MIN_CHARS_PER_PAGE * Math.max(1, totalPages) / 4) {
      return { kind: "unsupported", reason: "PDF has no text layer; scanned PDFs are not yet supported" };
    }
    return { kind: "extracted", type: "reading", title: titleFromFilename(filename), markdown: cleaned };
  } catch {
    return { kind: "unsupported", reason: "PDF could not be parsed" };
  }
}
