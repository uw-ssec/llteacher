/* --------------------------------------------------------------------------
   OKF bundle housekeeping: index.md and log.md (#42).

   The spec reserves both filenames and pins their shape: index.md is "one or
   more sections, each grouping concepts under a heading" with entries
   formatted `* [Title](url) - description`; log.md is "date-grouped entries,
   newest first" under ISO 8601 headings.

   Maintaining them automatically is what makes the folder tree a real bundle
   rather than a directory listing we happen to render -- another OKF
   consumer pointed at an export of this data gets a conformant bundle, and
   the instructor gets a change history in-format for free.

   Every function here is pure and takes the date as a parameter. That is
   deliberate: a `new Date()` inside would make the log untestable.
   -------------------------------------------------------------------------- */

export interface IndexEntry {
  path: string;
  title: string | null;
  description: string | null;
}

export function directoryOf(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/");
}

/** Every ancestor of a path, root ("") first. Used to decide which index.md
 *  files a create or delete invalidates. */
export function parentDirectories(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  const directories = [""];
  for (let i = 0; i < segments.length; i++) {
    directories.push(segments.slice(0, i + 1).join("/"));
  }
  return directories;
}

export function renderIndex(directoryPath: string, entries: IndexEntry[]): string {
  const heading = directoryPath === "" ? "Knowledge base" : directoryPath;
  if (entries.length === 0) return `## ${heading}\n\nNo documents yet.\n`;

  const lines = entries.map((entry) => {
    const label = entry.title ?? entry.path.split("/").pop() ?? entry.path;
    const suffix = entry.description ? ` - ${entry.description}` : "";
    return `* [${label}](/${entry.path})${suffix}`;
  });
  return `## ${heading}\n\n${lines.join("\n")}\n`;
}

const LOG_HEADER = "# Log";

interface LogSection {
  date: string;
  entries: string[];
}

/** Parsed rather than spliced. The previous implementation inserted a new
 *  heading directly beneath "# Log" on the assumption that an unseen date must
 *  be the newest — so backfilling 09-08 into a log holding 09-09 and 09-07
 *  produced 09-08, 09-09, 09-07, violating OKF's newest-first rule. A
 *  same-date append also ate the blank line before the following heading.
 *
 *  Both were splice bugs, so the splice is gone: parse to sections, edit the
 *  structure, re-render. Ordering and spacing then hold by construction rather
 *  than by getting an index right. */
function parseLog(existing: string): LogSection[] {
  const sections: LogSection[] = [];
  let current: LogSection | null = null;

  for (const line of existing.split("\n")) {
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (heading) {
      current = { date: heading[1], entries: [] };
      sections.push(current);
      continue;
    }
    if (current && line.trim() !== "") current.entries.push(line.trim());
  }
  return sections;
}

function renderLog(sections: LogSection[]): string {
  // ISO-8601 dates sort correctly as plain strings, which is most of why the
  // format is worth insisting on.
  const ordered = [...sections].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const body = ordered
    .map((section) => `## ${section.date}\n\n${section.entries.join("\n")}\n`)
    .join("\n");
  return `${LOG_HEADER}\n\n${body}`;
}

export function appendLogEntry(
  existing: string,
  isoDate: string,
  message: string,
): string {
  const sections = parseLog(existing);
  const section = sections.find((s) => s.date === isoDate);

  if (section) section.entries.push(message);
  else sections.push({ date: isoDate, entries: [message] });

  return renderLog(sections);
}
