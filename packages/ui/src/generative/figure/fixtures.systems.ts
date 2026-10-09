/* One realistic, valid input per health information systems figure tool --
   the same JSON a model would send. Illustrative workflows and mappings for
   a nursing informatics course, not taken from any real patient or
   organisation. Codes are shown by the figure "as given"; the ones here are
   for teaching and should be checked in the terminology browser like any
   other. Shared by the render tests and (via the integrator) the registry
   and showcase. */

export const SYSTEMS_FIXTURES: Record<string, unknown> = {
  // One scheduled medication pass, on a paper MAR and then with BCMA.
  showWorkflowComparison: {
    process: "Medication administration on a medical-surgical unit",
    roles: ["Nurse", "Pharmacist", "Patient", "EHR"],
    currentLabel: "Paper MAR",
    futureLabel: "Bar code medication administration (BCMA)",
    current: [
      { role: "Nurse", action: "Checks paper MAR for medications due", kind: "documentation", minutes: 2 },
      { role: "Nurse", action: "Finds a dose missing from the patient's drawer", kind: "task", minutes: 2 },
      { role: "Nurse", action: "Calls pharmacy about the missing dose", kind: "communication", minutes: 3 },
      { role: "Pharmacist", action: "Verifies the order and sends the dose", kind: "task", minutes: 3 },
      { role: "Nurse", action: "Waits for the dose to arrive", kind: "wait", minutes: 10 },
      { role: "Nurse", action: "Compares wristband with the MAR by eye", kind: "decision", minutes: 1 },
      { role: "Patient", action: "States name and date of birth", kind: "communication", minutes: 1 },
      { role: "Nurse", action: "Gives the medication", kind: "task", minutes: 2 },
      { role: "Nurse", action: "Initials the paper MAR", kind: "documentation", minutes: 1 },
    ],
    future: [
      { role: "Nurse", action: "Opens the eMAR worklist of doses due", kind: "task", minutes: 1 },
      { role: "Nurse", action: "Removes the dose from the dispensing cabinet", kind: "task", minutes: 2 },
      { role: "Patient", action: "States name and date of birth", kind: "communication", minutes: 1 },
      { role: "Nurse", action: "Scans wristband, then the medication", kind: "task", minutes: 1 },
      { role: "EHR", action: "Checks patient, drug, dose, route and time", kind: "decision", minutes: 0 },
      { role: "Nurse", action: "Gives the medication", kind: "task", minutes: 2 },
      { role: "EHR", action: "Records the administration in the eMAR", kind: "documentation", minutes: 0 },
    ],
  },
  // An admission nursing assessment's vital signs, pain and fall risk.
  showStandardsMap: {
    scenario: "Admission nursing assessment: vital signs, pain and fall risk",
    elements: [
      { element: "Pain intensity 7/10 (0–10 numeric rating scale)", standard: "loinc", code: "72514-3", display: "Pain severity - 0-10 verbal numeric rating [Score] - Reported" },
      { element: "Body temperature 38.4", standard: "loinc", code: "8310-5", display: "Body temperature" },
      { element: "Heart rate 104", standard: "loinc", code: "8867-4", display: "Heart rate" },
      { element: "Temperature unit: °C", standard: "ucum", code: "Cel", display: "degree Celsius" },
      { element: "Heart rate unit: beats per minute", standard: "ucum", code: "/min", display: "per minute" },
      { element: "At risk for falls", standard: "snomed-ct", code: "129839007", display: "At increased risk for falls (finding)" },
      { element: "Nursing diagnosis: acute pain", standard: "nanda-i", code: "00132", display: "Acute pain" },
    ],
    exchange: { standard: "fhir", resource: "Observation" },
  },
  // Patient safety reports through Meaningful Use, with one local go-live.
  showHealthItTimeline: {
    highlight: ["to-err-is-human", "fda-bar-code-rule", "tiger-initiative", "hitech-act", "meaningful-use-stage-1"],
    range: { from: 1999, to: 2011 },
    localEvents: [{ year: 2008, label: "Example hospital goes live with BCMA on its medical-surgical units" }],
  },
};
