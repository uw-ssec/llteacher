const FENCE = "---";

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

function quoteIfNeeded(value: string): string {
  return /[:#"]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function splitFrontmatter(raw: string): { header: string[] | null; rest: string } {
  const lines = raw.split("\n");
  if (lines[0] !== FENCE) return { header: null, rest: raw };
  const end = lines.indexOf(FENCE, 1);
  if (end === -1) return { header: null, rest: raw };
  return { header: lines.slice(1, end), rest: lines.slice(end + 1).join("\n") };
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const { header, rest } = splitFrontmatter(raw);
  if (!header) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of header) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2]!;
    frontmatter[m[1]!] = value.startsWith("{") ? value.trim() : unquote(value);
  }
  return { frontmatter, body: rest };
}

export function setFrontmatterKeys(raw: string, keys: Record<string, string>): string {
  const { header, rest } = splitFrontmatter(raw);
  const lines = header ? [...header] : [];
  const entries = Object.entries(keys);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [key, value] = entries[i]!;
    const rendered = `${key}: ${quoteIfNeeded(value)}`;
    const existing = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (existing !== -1) {
      lines[existing] = rendered;
      continue;
    }
    const afterDescription = lines.findIndex((l) => l.startsWith("description:"));
    const at = afterDescription === -1 ? lines.length : afterDescription + 1;
    lines.splice(at, 0, rendered);
  }
  return [FENCE, ...lines, FENCE, rest].join("\n");
}
