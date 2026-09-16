import { unzipSync, strFromU8 } from "fflate";
import { decodeXml, titleFromFilename, type ExtractionOutcome } from "./types";

const PARA_RE = /<w:p[\s>][\s\S]*?<\/w:p>/g;
const STYLE_RE = /<w:pStyle w:val="([^"]+)"/;
const RUN_TEXT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g;

function headingLevel(style: string | undefined): number {
  const m = style && /^Heading(\d)$/i.exec(style);
  return m ? Math.min(6, Number(m[1])) : 0;
}

export async function extractDocx(filename: string, bytes: ArrayBuffer): Promise<ExtractionOutcome> {
  let xml: string;
  try {
    const files = unzipSync(new Uint8Array(bytes));
    const doc = files["word/document.xml"];
    if (!doc) return { kind: "unsupported", reason: "docx has no word/document.xml" };
    xml = strFromU8(doc);
  } catch {
    return { kind: "unsupported", reason: "docx could not be unzipped" };
  }
  const blocks: string[] = [];
  let firstHeading: string | null = null;
  for (const para of xml.match(PARA_RE) ?? []) {
    let text = "";
    for (const m of para.matchAll(RUN_TEXT_RE)) {
      text += m[0] === "<w:tab/>" ? "\t" : m[0] === "<w:br/>" ? "\n" : decodeXml(m[1] ?? "");
    }
    text = text.trim();
    if (text === "") continue;
    const level = headingLevel(STYLE_RE.exec(para)?.[1]);
    if (level > 0) {
      blocks.push(`${"#".repeat(level)} ${text}`);
      firstHeading ??= text;
    } else {
      blocks.push(text);
    }
  }
  if (blocks.length === 0) return { kind: "unsupported", reason: "docx contains no text" };
  return { kind: "extracted", type: "lecture", title: firstHeading ?? titleFromFilename(filename), markdown: blocks.join("\n\n") };
}
