/* --------------------------------------------------------------------------
   #86: the CSV parser.

   These are the four things that actually break real instructors' files, and
   they are the reason this is parsed rather than split on commas.
   -------------------------------------------------------------------------- */

import { describe, it, expect } from "vitest";
import { parseRosterCsv } from "./csv";

describe("parseRosterCsv (#86)", () => {
  it("strips the BOM Excel's UTF-8 export writes", () => {
    // Without this the first header is "﻿email", every lookup for
    // "email" misses, and a file that looks perfect imports nothing. This is
    // the single most common way a real file fails.
    const result = parseRosterCsv('﻿email,name\nada@uw.edu,Ada\n');
    expect(result.error).toBeUndefined();
    expect(result.rows[0]!.values).toEqual({ email: "ada@uw.edu", name: "Ada" });
  });

  it("keeps a quoted comma inside one field", () => {
    const result = parseRosterCsv('email,name\nada@uw.edu,"Lovelace, Ada"\n');
    expect(result.rows[0]!.values.name).toBe("Lovelace, Ada");
  });

  it("reads a doubled quote as one literal quote", () => {
    const result = parseRosterCsv('email,name\nada@uw.edu,"Ada ""The Countess"" Lovelace"\n');
    expect(result.rows[0]!.values.name).toBe('Ada "The Countess" Lovelace');
  });

  it("handles a quoted field that spans lines", () => {
    const result = parseRosterCsv('email,name\nada@uw.edu,"Ada\nLovelace"\n');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.values.name).toBe("Ada\nLovelace");
  });

  it("normalizes CRLF and bare CR", () => {
    // A stray CR left in a value makes an address that looks identical on
    // screen and never matches a blind index.
    const result = parseRosterCsv("email,name\r\nada@uw.edu,Ada\r\n");
    expect(result.rows[0]!.values.email).toBe("ada@uw.edu");
  });

  for (const header of ["Email", "E-mail", "Email Address", "  email  ", "UW Email"]) {
    it(`accepts "${header}" as the email column`, () => {
      const result = parseRosterCsv(`${header},Full Name\nada@uw.edu,Ada\n`);
      expect(result.error).toBeUndefined();
      expect(result.rows[0]!.values.email).toBe("ada@uw.edu");
      expect(result.rows[0]!.values.name).toBe("Ada");
    });
  }

  it("ignores columns it does not use rather than rejecting the file", () => {
    // A real export carries a student number and a section; refusing over
    // them would be hostile.
    const result = parseRosterCsv("email,Student Number,Section\nada@uw.edu,12345,AA\n");
    expect(result.error).toBeUndefined();
    expect(result.rows[0]!.values).toEqual({ email: "ada@uw.edu" });
  });

  it("numbers rows the way the instructor's spreadsheet does", () => {
    const result = parseRosterCsv("email\na@uw.edu\n\nb@uw.edu\n");
    // Blank lines do not consume a number: the instructor is looking for a
    // row they can see.
    expect(result.rows.map((r) => r.line)).toEqual([1, 2]);
  });

  it("skips leading blank lines before the header", () => {
    const result = parseRosterCsv("\n\nemail\nada@uw.edu\n");
    expect(result.rows).toHaveLength(1);
  });

  it("names the fix when there is no email column", () => {
    const result = parseRosterCsv("name,role\nAda,student\n");
    expect(result.error).toMatch(/must be Email/i);
    expect(result.rows).toHaveLength(0);
  });

  it("reports an empty file rather than importing nothing silently", () => {
    expect(parseRosterCsv("   \n\n").error).toMatch(/empty/i);
  });

  it("reports an unterminated quote instead of guessing", () => {
    expect(parseRosterCsv('email,name\nada@uw.edu,"Ada\n').error).toMatch(/unclosed quote/i);
  });

  it("refuses an over-long file rather than silently truncating it", () => {
    // Importing the first 1000 of 4000 rows and reporting success leaves the
    // instructor with no way to see which 3000 are missing.
    const body = Array.from({ length: 1001 }, (_, i) => `s${i}@uw.edu`).join("\n");
    const result = parseRosterCsv(`email\n${body}\n`);
    expect(result.error).toMatch(/more than 1000 rows/i);
    expect(result.rows).toHaveLength(0);
  });
});
