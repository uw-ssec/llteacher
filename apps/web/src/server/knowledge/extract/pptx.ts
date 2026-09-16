import { unzipSync, strFromU8 } from "fflate";
import { decodeXml, MAX_PART_BYTES, titleFromFilename, type ExtractionOutcome } from "./types";

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const PARA_RE = /<a:p>[\s\S]*?<\/a:p>/g;
const TEXT_RE = /<a:t>([\s\S]*?)<\/a:t>/g;

/** `<p:sldId ... r:id="rIdN"/>` elements in `ppt/presentation.xml`, in the
 *  document's own slide order (which need not match the slideN.xml filenames). */
const SLD_ID_RE = /<p:sldId\b[^>]*\br:id="([^"]+)"/g;

/** A single `<Relationship .../>` element from `ppt/_rels/presentation.xml.rels`.
 *  Attribute order is not guaranteed, so Id and Target are pulled out separately. */
const RELATIONSHIP_TAG_RE = /<Relationship\b[^>]*\/?>/g;
const REL_ID_RE = /\bId="([^"]+)"/;
const REL_TARGET_RE = /\bTarget="([^"]+)"/;

/** Resolves the presentation's own slide order via `ppt/presentation.xml`
 *  (`<p:sldId r:id="...">` order) and `ppt/_rels/presentation.xml.rels`
 *  (`rId` -> `Target` path). Returns null when either part is absent or the
 *  mapping resolves to no usable slide paths, so the caller can fall back to
 *  ordering by the `slideN.xml` filename instead. */
function presentationOrder(files: Record<string, Uint8Array>): string[] | null {
  const presentation = files["ppt/presentation.xml"];
  const rels = files["ppt/_rels/presentation.xml.rels"];
  if (!presentation || !rels) return null;

  const relIdToTarget = new Map<string, string>();
  for (const tag of strFromU8(rels).match(RELATIONSHIP_TAG_RE) ?? []) {
    const id = REL_ID_RE.exec(tag)?.[1];
    const target = REL_TARGET_RE.exec(tag)?.[1];
    if (id && target) relIdToTarget.set(id, target);
  }

  const order: string[] = [];
  for (const m of strFromU8(presentation).matchAll(SLD_ID_RE)) {
    const target = relIdToTarget.get(m[1]);
    if (!target) continue;
    // Targets are relative to ppt/_rels, i.e. relative to ppt/: normally
    // "slides/slideN.xml", but may be package-absolute ("/ppt/slides/...")
    // or explicitly relative ("../slides/...").
    let rel = target;
    if (rel.startsWith("/ppt/")) rel = rel.slice("/ppt/".length);
    else if (rel.startsWith("../")) rel = rel.slice(3);
    const path = `ppt/${rel}`;
    if (SLIDE_RE.test(path) && files[path]) order.push(path);
  }
  return order.length > 0 ? order : null;
}

export async function extractPptx(filename: string, bytes: ArrayBuffer): Promise<ExtractionOutcome> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes), {
      filter: (f) =>
        f.originalSize <= MAX_PART_BYTES &&
        (SLIDE_RE.test(f.name) ||
          f.name === "ppt/presentation.xml" ||
          f.name === "ppt/_rels/presentation.xml.rels"),
    });
  } catch {
    return { kind: "unsupported", reason: "pptx could not be unzipped" };
  }

  const byPresentationOrder = presentationOrder(files);

  // Slide heading numbers differ by source: presentation order renumbers
  // slides 1..k by position (the filename digit is not the document's
  // order), while the filename-order fallback keeps using that digit.
  let slidePaths: string[];
  let headingFor: (position: number, path: string) => number;
  if (byPresentationOrder) {
    slidePaths = byPresentationOrder;
    headingFor = (position) => position + 1;
  } else {
    const byFilename = Object.keys(files)
      .map((name) => ({ name, n: Number(SLIDE_RE.exec(name)?.[1] ?? NaN) }))
      .filter((s) => !Number.isNaN(s.n))
      .sort((a, b) => a.n - b.n);
    slidePaths = byFilename.map((s) => s.name);
    const numberByPath = new Map(byFilename.map((s) => [s.name, s.n]));
    headingFor = (_position, path) => numberByPath.get(path)!;
  }

  if (slidePaths.length === 0) return { kind: "unsupported", reason: "pptx has no slides" };

  const blocks: string[] = [];
  slidePaths.forEach((path, position) => {
    const xml = strFromU8(files[path]!);
    const paras = (xml.match(PARA_RE) ?? [])
      .map((p) => [...p.matchAll(TEXT_RE)].map((m) => decodeXml(m[1] ?? "")).join("").trim())
      .filter((t) => t !== "");
    if (paras.length === 0) return;
    blocks.push(`## Slide ${headingFor(position, path)}`, paras.join("\n\n"));
  });

  if (blocks.length === 0) return { kind: "unsupported", reason: "pptx slides contain no text" };
  return { kind: "extracted", type: "slides", title: titleFromFilename(filename), markdown: blocks.join("\n\n") };
}
