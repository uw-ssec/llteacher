/* --------------------------------------------------------------------------
   CSV parsing for roster import (#86).

   Hand-written rather than a dependency, and the reason is scope rather than
   pride: this parses one shape -- a small header-plus-rows file an instructor
   exported from a spreadsheet -- and needs to handle exactly the four things
   that actually break such files in practice. A general CSV library brings a
   parser for dialects nobody here will produce, plus a supply-chain surface,
   for a hundred lines of well-understood text handling.

   The four things, all of which #86 names as must-cover:

   1. BOM. Excel's "CSV UTF-8" export writes U+FEFF first, so the first
      header becomes "\\uFEFFemail" and every lookup for "email" misses. This
      is the single most common way a real instructor's file fails.
   2. Quoted fields containing commas, and "" as an escaped quote inside
      them. "Lovelace, Ada" is one field, not two.
   3. Line endings. Excel on Windows writes CRLF; a stray CR left in a value
      makes an email address that looks identical on screen and never matches.
   4. Header variants. Instructors write "E-mail", "Email Address", "Name",
      "Full Name". Matching them loosely costs a normalization function and
      saves an instructor from a file that "looks right" and imports nothing.
   -------------------------------------------------------------------------- */

export interface CsvRow {
  /** 1-based, header excluded, so it matches the row number the instructor
   *  sees in their spreadsheet once they account for the header. */
  line: number;
  values: Record<string, string>;
}

export interface CsvParseResult {
  rows: CsvRow[];
  /** Canonical header names, in file order. */
  headers: string[];
  error?: string;
}

/** Splits one CSV line into fields, honouring quotes. Returns null when the
 *  line ends inside an unterminated quote, which means the "line" is
 *  actually part of a multi-line quoted value. */
function splitLine(line: string): string[] | null {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        // "" inside a quoted field is one literal quote.
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (inQuotes) return null;
  fields.push(current);
  return fields;
}

/** Header matching is loose on purpose -- see (4) above. Lowercased with
 *  every non-alphanumeric removed, so "E-mail", "E Mail" and "email" all
 *  collapse to "email". */
function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Canonical field name for a normalized header, or null when the column is
 *  one this importer does not use (extra spreadsheet columns are ignored
 *  rather than rejected -- an instructor's export routinely carries a
 *  student number or a section, and refusing the file over it would be
 *  hostile). */
function canonicalField(normalized: string): string | null {
  if (["email", "emailaddress", "mail", "uwemail"].includes(normalized)) return "email";
  if (["name", "fullname", "displayname", "studentname"].includes(normalized)) return "name";
  if (["role", "type", "membership"].includes(normalized)) return "role";
  return null;
}

const MAX_ROWS = 1000;

export function parseRosterCsv(input: string): CsvParseResult {
  // (1) BOM, and (3) CRLF/CR normalized before anything else looks at the
  // text, so no later step has to know about either.
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  // Leading blank lines are common in exported files.
  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor += 1;
  if (cursor >= lines.length) return { rows: [], headers: [], error: "That file is empty." };

  const headerFields = splitLine(lines[cursor]!);
  if (!headerFields) {
    return { rows: [], headers: [], error: "The header row has an unclosed quote." };
  }
  cursor += 1;

  const headers = headerFields.map((h) => canonicalField(normalizeHeader(h)) ?? "");
  if (!headers.includes("email")) {
    return {
      rows: [],
      headers: [],
      // Names the fix, not the fault: the instructor has a file open and
      // needs to know which column to rename.
      error:
        "No email column found. The first row must name the columns, and one of them must be Email.",
    };
  }

  const rows: CsvRow[] = [];
  let lineNumber = 0;
  let pending: string | null = null;

  for (; cursor < lines.length; cursor += 1) {
    // (2) A quoted field may span lines; rejoin until the quotes balance.
    const raw: string = pending === null ? lines[cursor]! : `${pending}\n${lines[cursor]!}`;
    const fields = splitLine(raw);
    if (!fields) {
      pending = raw;
      continue;
    }
    pending = null;

    if (fields.every((f) => f.trim() === "")) continue;
    lineNumber += 1;
    if (rows.length >= MAX_ROWS) {
      // Refused rather than truncated. Importing the first 1000 rows of a
      // 4000-row file and reporting success is the worse failure: the
      // instructor has no way to see which 3000 are missing.
      return {
        rows: [],
        headers,
        error: `That file has more than ${MAX_ROWS} rows. Split it and import in parts.`,
      };
    }

    const values: Record<string, string> = {};
    headers.forEach((name, i) => {
      if (name) values[name] = (fields[i] ?? "").trim();
    });
    rows.push({ line: lineNumber, values });
  }

  if (pending !== null) {
    return { rows: [], headers, error: "The file ends inside an unclosed quote." };
  }
  return { rows, headers };
}
