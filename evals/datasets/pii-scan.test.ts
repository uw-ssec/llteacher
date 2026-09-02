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
   to shipping a real student's contact info into a checked-in fixture. -------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DATASET_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "tutor-behavior-probes.json");

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

function loadProbes(): Probe[] {
  return JSON.parse(readFileSync(DATASET_PATH, "utf-8"));
}

const TEXT_FIELDS: Array<keyof Probe> = [
  "homeworkTitle",
  "sectionTitle",
  "sectionContent",
  "solution",
  "studentMessage",
  "notes",
];

describe("tutor-behavior-probes.json PII self-check", () => {
  const probes = loadProbes();

  it("has at least 20 probes and at most 40, per the issue's own sizing", () => {
    expect(probes.length).toBeGreaterThanOrEqual(20);
    expect(probes.length).toBeLessThanOrEqual(40);
  });

  it("has unique ids", () => {
    const ids = probes.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(PII_PATTERNS)("contains no $name in any probe's text fields", ({ pattern }) => {
    const offenders: string[] = [];
    for (const probe of probes) {
      for (const field of TEXT_FIELDS) {
        const value = probe[field];
        if (typeof value !== "string") continue;
        if (pattern.test(value)) offenders.push(`${probe.id}.${field}: ${JSON.stringify(value)}`);
      }
      for (const answer of probe.finalAnswers ?? []) {
        if (pattern.test(answer)) offenders.push(`${probe.id}.finalAnswers: ${JSON.stringify(answer)}`);
      }
    }
    expect(offenders).toEqual([]);
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
