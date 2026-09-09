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

const LOG_HEADER = "# Log\n";

export function appendLogEntry(
  existing: string,
  isoDate: string,
  message: string,
): string {
  const heading = `## ${isoDate}`;

  if (existing.trim() === "") {
    return `${LOG_HEADER}\n${heading}\n\n${message}\n`;
  }

  // Today's section already exists: append inside it, before the next
  // date heading (or at the end if it is the newest).
  if (existing.includes(`${heading}\n`)) {
    const start = existing.indexOf(`${heading}\n`) + heading.length + 1;
    const nextHeading = existing.indexOf("\n## ", start);
    const insertAt = nextHeading === -1 ? existing.length : nextHeading + 1;
    const before = existing.slice(0, insertAt).replace(/\n*$/, "\n");
    return `${before}${message}\n${existing.slice(insertAt)}`;
  }

  // A newer date goes directly under the header — newest first.
  const afterHeader = existing.indexOf("\n", existing.indexOf(LOG_HEADER)) + 1;
  const body = existing.slice(afterHeader).replace(/^\n+/, "");
  return `${LOG_HEADER}\n${heading}\n\n${message}\n\n${body}`;
}
