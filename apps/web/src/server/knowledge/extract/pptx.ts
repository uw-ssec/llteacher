import { unzipSync, strFromU8 } from "fflate";
import { decodeXml, titleFromFilename, type ExtractionOutcome } from "./types";

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const PARA_RE = /<a:p>[\s\S]*?<\/a:p>/g;
const TEXT_RE = /<a:t>([\s\S]*?)<\/a:t>/g;

export async function extractPptx(filename: string, bytes: ArrayBuffer): Promise<ExtractionOutcome> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch {
    return { kind: "unsupported", reason: "pptx could not be unzipped" };
  }
  const slides = Object.keys(files)
    .map((name) => ({ name, n: Number(SLIDE_RE.exec(name)?.[1] ?? NaN) }))
    .filter((s) => !Number.isNaN(s.n))
    .sort((a, b) => a.n - b.n);
  if (slides.length === 0) return { kind: "unsupported", reason: "pptx has no slides" };
  const blocks: string[] = [];
  for (const slide of slides) {
    const xml = strFromU8(files[slide.name]!);
    const paras = (xml.match(PARA_RE) ?? [])
      .map((p) => [...p.matchAll(TEXT_RE)].map((m) => decodeXml(m[1] ?? "")).join("").trim())
      .filter((t) => t !== "");
    if (paras.length === 0) continue;
    blocks.push(`## Slide ${slide.n}`, paras.join("\n\n"));
  }
  if (blocks.length === 0) return { kind: "unsupported", reason: "pptx slides contain no text" };
  return { kind: "extracted", type: "slides", title: titleFromFilename(filename), markdown: blocks.join("\n\n") };
}
