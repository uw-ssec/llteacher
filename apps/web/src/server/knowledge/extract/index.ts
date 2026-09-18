import type { OcrOptions } from "./ocr";
import { extensionOf } from "../convert";
import { extractText, sniffTranscript } from "./text";
import { extractDocx } from "./docx";
import { extractPptx } from "./pptx";
import { extractPdf } from "./pdf";
import type { ExtractionOutcome, Extractor } from "./types";

export type { ExtractionOutcome, Extractor } from "./types";
export { sniffTranscript };

const BY_EXTENSION: Record<string, Extractor> = {
  txt: extractText, md: extractText, vtt: extractText, srt: extractText,
  docx: extractDocx,
  pptx: extractPptx,
  pdf: extractPdf,
};

export async function extract(filename: string, bytes: ArrayBuffer, ocr?: OcrOptions): Promise<ExtractionOutcome> {
  if (extensionOf(filename) === "pdf") return extractPdf(filename, bytes, ocr);
  const extractor = BY_EXTENSION[extensionOf(filename)];
  if (!extractor) {
    return { kind: "unsupported", reason: `Text extraction for .${extensionOf(filename)} is not supported yet.` };
  }
  return extractor(filename, bytes);
}
