const ID_RE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const RESERVED = new Set(["index", "log"]);

export function isValidConceptId(id: string): boolean {
  if (!ID_RE.test(id)) return false;
  const segments = id.split("/");
  return !RESERVED.has(segments[segments.length - 1]!);
}

export function slugSegment(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "untitled" : slug;
}

export function conceptIdFromUpload(relativePath: string | null, filename: string): string {
  const dirs = (relativePath ?? "")
    .split("/")
    .slice(0, -1)
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .map(slugSegment);
  let base = slugSegment(filename.replace(/\.[^.]+$/, ""));
  if (RESERVED.has(base)) base = `${base}-material`;
  return [...dirs, base].join("/");
}
