export type ExtractionOutcome =
  | { kind: "extracted"; type: string; title: string; markdown: string }
  | { kind: "unsupported"; reason: string };

export type Extractor = (filename: string, bytes: ArrayBuffer) => Promise<ExtractionOutcome>;

export function titleFromFilename(filename: string): string {
  return filename.split("/").pop()!.replace(/\.[^.]+$/, "").trim() || "Untitled";
}

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}
