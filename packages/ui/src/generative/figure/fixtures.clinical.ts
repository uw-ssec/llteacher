/* One realistic, valid input per clinical informatics figure tool -- the
   same JSON a model would send. Illustrative numbers, clinically sensible,
   not taken from any real patient or published validation study. Shared by
   the render tests and (via the integrator) the registry and showcase. */

export const CLINICAL_FIXTURES: Record<string, unknown> = {
  // A sepsis screening alert checked against chart review in 1,000 ED visits.
  showDiagnosticAccuracy: {
    tp: 80,
    fp: 135,
    fn: 20,
    tn: 765,
    testName: "Sepsis screening alert",
    conditionName: "sepsis",
  },
  // The same alert's accuracy, used on a general ward where 2% have sepsis.
  showPrevalenceEffect: {
    sensitivity: 0.8,
    specificity: 0.85,
    prevalence: 0.02,
    testName: "Sepsis screening alert",
  },
  // An early warning score's thresholds for ICU transfer within 24 hours.
  showRocCurve: {
    label: "Early warning score, ICU transfer within 24 h",
    points: [
      { threshold: "≥ 7", sensitivity: 0.3, specificity: 0.97 },
      { threshold: "≥ 6", sensitivity: 0.45, specificity: 0.93 },
      { threshold: "≥ 5", sensitivity: 0.62, specificity: 0.86 },
      { threshold: "≥ 4", sensitivity: 0.75, specificity: 0.77 },
      { threshold: "≥ 3", sensitivity: 0.86, specificity: 0.62 },
      { threshold: "≥ 2", sensitivity: 0.94, specificity: 0.42 },
    ],
  },
  // An inpatient stay for urosepsis, from ED arrival to discharge.
  showPatientTimeline: {
    patientLabel: "Patient A, 68 y",
    events: [
      { time: "2026-03-03T08:40", category: "encounter", label: "ED arrival", detail: "Fever and new confusion" },
      { time: "2026-03-03T08:55", category: "vital", label: "Triage vitals", detail: "T 38.9 °C, HR 118, BP 92/58, RR 24", abnormal: true },
      { time: "2026-03-03T09:10", category: "order", label: "Sepsis order set", detail: "Cultures, lactate, fluids, antibiotics" },
      { time: "2026-03-03T09:25", category: "lab", label: "Lactate", detail: "4.1 mmol/L", abnormal: true },
      { time: "2026-03-03T09:30", category: "lab", label: "Blood cultures drawn", detail: "2 sets" },
      { time: "2026-03-03T09:50", category: "medication", label: "Piperacillin-tazobactam", detail: "4.5 g IV" },
      { time: "2026-03-03T10:05", category: "medication", label: "IV fluid bolus", detail: "30 mL/kg lactated Ringer's" },
      { time: "2026-03-03T12:30", category: "lab", label: "Repeat lactate", detail: "2.2 mmol/L", abnormal: true },
      { time: "2026-03-03T14:00", category: "encounter", label: "Admitted to medicine ward" },
      { time: "2026-03-04T07:00", category: "lab", label: "Blood culture result", detail: "Gram-negative rods, 2 of 2 sets", abnormal: true },
      { time: "2026-03-04T10:00", category: "note", label: "Infectious disease consult", detail: "Narrow to ceftriaxone" },
      { time: "2026-03-04T11:00", category: "medication", label: "Ceftriaxone", detail: "2 g IV daily" },
      { time: "2026-03-05T08:00", category: "vital", label: "Morning vitals", detail: "T 37.1 °C, HR 84, BP 118/72, RR 16" },
      { time: "2026-03-06T11:30", category: "encounter", label: "Discharged home" },
    ],
  },
  // A sepsis alert whose last input was never resulted.
  showCdsRule: {
    name: "Sepsis alert: suspected infection with organ dysfunction",
    logic: "all",
    conditions: [
      { label: "Suspected infection (blood cultures ordered)", field: "bloodCulturesOrdered", operator: "=", value: "yes" },
      { label: "Systolic blood pressure ≤ 100 mmHg", field: "systolicBP", operator: "<=", value: 100, unit: "mmHg" },
      { label: "Respiratory rate ≥ 22 per minute", field: "respiratoryRate", operator: ">=", value: 22, unit: "/min" },
      { label: "Lactate ≥ 2 mmol/L", field: "lactate", operator: ">=", value: 2, unit: "mmol/L" },
    ],
    patient: { bloodCulturesOrdered: "yes", systolicBP: 96, respiratoryRate: 24, heartRate: 112, lactate: null },
    action: "Notify the covering clinician to assess for sepsis and consider the sepsis bundle.",
  },
};
