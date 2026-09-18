/* --------------------------------------------------------------------------
   #89 requirement: "eval dataset probes contain no real student PII
   (automated regex scan)". These probes are manually authored, synthetic
   statistics homework content -- no real student ever produced any string
   in tutor-behavior-probes.json -- but the dataset is the one file in this
   harness contributors will keep editing (new probes, new categories), so
   this is a standing guard against a copy-pasted real transcript or a
   real name/contact string sneaking in later, not a one-time audit.

   Deliberately over-broad rather than narrowly tuned: a false positive here
   just means a contributor has to rephrase a probe (e.g. avoid writing an
   email-shaped string even as a hypothetical), which is a small cost next
   to shipping a real student's contact info into a checked-in fixture.

   #90 review (final-review fix): apps/web/scripts/exportFlaggedFeedback.ts
   writes REAL, verbatim student messages and free-text comments to
   datasets/flagged-feedback-export.json, and that script's own console
   output tells a human to "run the existing PII scan" against the merged
   result before hand-merging any of it into tutor-behavior-probes.json --
   an instruction this file previously couldn't fulfill, since DATASET_PATH
   pointed only at the curated probes and never looked at the export file at
   all. `scanForPii` below is the shared mechanism (unit-tested directly,
   below, against inline fixtures so this coverage doesn't depend on a
   local-only export file existing on disk) and is applied to BOTH files:
   the curated dataset unconditionally, and the export file whenever it's
   present (`describe.skipIf` -- it's gitignored and only ever exists
   locally after a human runs the export script, never in CI). -------------------------------------------------------------------------- */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DATASET_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "tutor-behavior-probes.json");
const EXPORT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "flagged-feedback-export.json");

interface Probe {
  id: string;
  category: string;
  homeworkTitle: string;
  sectionTitle: string;
  sectionContent: string;
  solution: string;
  finalAnswers?: string[];
  studentMessage: string;
  notes?: string;
}

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "email address", pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  // UW NetID-flavored addresses specifically, in case a bare "@uw.edu" ever
  // shows up without a full local-part (the pattern above already needs a
  // local-part, so this is a defensive second net).
  { name: "UW email domain", pattern: /@(?:uw|washington)\.edu\b/i },
  // US phone numbers: (206) 555-0100, 206-555-0100, 206.555.0100, +1 206 555 0100.
  { name: "phone number", pattern: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/ },
  // SSN-shaped (###-##-####) -- always disallowed regardless of validity.
  { name: "SSN-shaped number", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  // A 7-9 digit UW student number, written as a bare number of that length --
  // deliberately loose, since section content legitimately contains other
  // numbers (n = 25, sigma = 15); this only flags a run of 7+ consecutive
  // digits, which no probe in this dataset should ever need.
  { name: "student-ID-shaped digit run", pattern: /\b\d{7,}\b/ },
  // Credit-card-shaped digit groups.
  { name: "credit-card-shaped number", pattern: /\b\d{4}[\s-]\d{4}[\s-]\d{4}[\s-]\d{4}\b/ },
];

const TEXT_FIELDS: Array<keyof Probe> = [
  "homeworkTitle",
  "sectionTitle",
  "sectionContent",
  "solution",
  "studentMessage",
  "notes",
];

function loadRecords(filePath: string): Probe[] {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

/** The scan mechanism itself, shared between the curated dataset and
 *  exportFlaggedFeedback.ts's staging file -- both are arrays of objects
 *  carrying the same TEXT_FIELDS shape (`ExportedProbe` in that script is a
 *  structural subset of `Probe`). Pulled out as its own function so it can
 *  be unit-tested directly against inline fixtures (below), independent of
 *  which file(s) happen to exist on disk in a given run. */
function scanForPii(records: Probe[], pattern: RegExp, fields: Array<keyof Probe> = TEXT_FIELDS): string[] {
  const offenders: string[] = [];
  for (const record of records) {
    for (const field of fields) {
      const value = record[field];
      if (typeof value !== "string") continue;
      if (pattern.test(value)) offenders.push(`${record.id}.${field}: ${JSON.stringify(value)}`);
    }
    for (const answer of record.finalAnswers ?? []) {
      if (pattern.test(answer)) offenders.push(`${record.id}.finalAnswers: ${JSON.stringify(answer)}`);
    }
  }
  return offenders;
}

describe("tutor-behavior-probes.json PII self-check", () => {
  const probes = loadRecords(DATASET_PATH);

  it("has at least 20 probes and at most 40, per the issue's own sizing", () => {
    expect(probes.length).toBeGreaterThanOrEqual(20);
    expect(probes.length).toBeLessThanOrEqual(40);
  });

  it("has unique ids", () => {
    const ids = probes.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(PII_PATTERNS)("contains no $name in any probe's text fields", ({ pattern }) => {
    expect(scanForPii(probes, pattern)).toEqual([]);
  });

  it("every probe has the fields the harness and scoring functions require", () => {
    for (const probe of probes) {
      expect(probe.id, "id").toBeTruthy();
      expect(probe.category, `${probe.id}.category`).toBeTruthy();
      expect(probe.sectionContent, `${probe.id}.sectionContent`).toBeTruthy();
      expect(probe.solution, `${probe.id}.solution`).toBeTruthy();
      expect(probe.studentMessage, `${probe.id}.studentMessage`).toBeTruthy();
    }
  });
});

// #90 review (final-review fix): scanForPii tested directly against inline
// fixtures, not just exercised indirectly via whichever files happen to
// exist on disk -- the export-file suite below is skipped entirely (via
// describe.skipIf) whenever a human hasn't run exportFlaggedFeedback.ts
// locally, which is true in CI and in a fresh checkout. Without this suite,
// the scan logic that gates real student data would have zero coverage in
// the common case, silently enforcing nothing.
describe("scanForPii mechanism", () => {
  const baseRecord: Probe = {
    id: "probe-1",
    category: "student_flagged",
    homeworkTitle: "HW 1",
    sectionTitle: "Sec 1",
    sectionContent: "clean content",
    solution: "clean solution",
    studentMessage: "clean message",
    notes: "clean notes",
  };

  it.each(PII_PATTERNS)("flags $name when present in a text field", ({ name, pattern }) => {
    const dirty: Record<string, string> = {
      "email address": "reach me at student@example.com",
      "UW email domain": "my netid is jdoe@uw.edu",
      "phone number": "call (206) 555-0199",
      "SSN-shaped number": "my ssn is 123-45-6789",
      "student-ID-shaped digit run": "my student id is 1234567",
      "credit-card-shaped number": "card 4111 1111 1111 1111",
    };
    const value = dirty[name];
    expect(value, `no fixture string authored for pattern "${name}"`).toBeTruthy();
    const records: Probe[] = [{ ...baseRecord, notes: value }];
    expect(scanForPii(records, pattern)).toEqual([`${baseRecord.id}.notes: ${JSON.stringify(value)}`]);
  });

  it("flags PII inside finalAnswers too", () => {
    const records: Probe[] = [{ ...baseRecord, finalAnswers: ["student@example.com"] }];
    expect(scanForPii(records, PII_PATTERNS[0]!.pattern)).toEqual([`${baseRecord.id}.finalAnswers: ${JSON.stringify("student@example.com")}`]);
  });

  it("reports no offenders for clean records", () => {
    for (const { pattern } of PII_PATTERNS) {
      expect(scanForPii([baseRecord], pattern)).toEqual([]);
    }
  });
});

// #90 review (final-review fix): datasets/flagged-feedback-export.json is
// apps/web/scripts/exportFlaggedFeedback.ts's staging output -- real,
// verbatim student messages and comments, gitignored, present only when a
// human has run that script locally. Never checked in, so this suite is a
// no-op (skipped) in CI and in a fresh checkout; scanForPii's own mechanism
// coverage lives in the "scanForPii mechanism" suite above regardless.
describe.skipIf(!existsSync(EXPORT_PATH))("flagged-feedback-export.json PII self-check (#90)", () => {
  const exported = existsSync(EXPORT_PATH) ? loadRecords(EXPORT_PATH) : [];

  it.each(PII_PATTERNS)("contains no $name in any exported row's text fields", ({ pattern }) => {
    expect(scanForPii(exported, pattern)).toEqual([]);
  });
});
