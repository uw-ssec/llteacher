/* --------------------------------------------------------------------------
   OKF link extraction (#42).

   OKF expresses relationships as ordinary markdown links, either
   bundle-absolute (leading "/") or relative to the source concept. The kind
   of relationship is carried by the surrounding prose, not the link, so this
   returns targets only -- there is nothing else to extract.

   Not a full markdown parser on purpose: the only construct that matters is
   `[text](href)`, and pulling in a parser to find it would mean loading a
   markdown AST in a Worker for a regex's worth of work. The two places a
   regex is genuinely wrong are fenced code blocks and inline code spans --
   in both, a link is a literal being shown to a reader, not a reference --
   so both are stripped before matching. Fences are stripped first: a fence
   body can contain stray backticks that would otherwise get misread as
   inline-span delimiters.
   -------------------------------------------------------------------------- */

export interface ParsedLink {
  /** The href exactly as written, before resolution. */
  rawHref: string;
  /** Bundle-relative concept id: no leading slash, no .md, no anchor. */
  targetPath: string;
}

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
/** Inline code spans: a run of N backticks, content, then the same run of N
 *  backticks -- the CommonMark delimiter shape. The backreference to the
 *  captured run (rather than a hardcoded single backtick) covers the
 *  `` `code with ` inside` `` form along with the plain `` `code` `` one. */
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g;
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** Anything with a scheme, a protocol-relative prefix, or a pure anchor is
 *  not a concept reference. */
const EXTERNAL_RE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Resolves "." and ".." against a directory, without Node's path module —
 *  this runs in a Worker. */
function normalise(segments: string[]): string {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

export function parseLinks(body: string, fromPath: string): ParsedLink[] {
  const prose = body.replace(FENCE_RE, "").replace(INLINE_CODE_RE, "");
  const fromDir = fromPath.split("/").slice(0, -1);

  const seen = new Set<string>();
  const links: ParsedLink[] = [];

  for (const match of prose.matchAll(LINK_RE)) {
    const rawHref = match[1];
    if (EXTERNAL_RE.test(rawHref)) continue;

    const withoutAnchor = rawHref.split("#")[0];
    if (withoutAnchor === "") continue;

    const withoutSuffix = withoutAnchor.replace(/\.md$/i, "");
    const targetPath = withoutSuffix.startsWith("/")
      ? normalise(withoutSuffix.slice(1).split("/"))
      : normalise([...fromDir, ...withoutSuffix.split("/")]);

    if (targetPath === "" || seen.has(targetPath)) continue;
    seen.add(targetPath);
    links.push({ rawHref, targetPath });
  }

  return links;
}
