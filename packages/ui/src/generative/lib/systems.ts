/* --------------------------------------------------------------------------
   Health information systems computation for the generative-UI figures.

   A clinical workflow's counts (steps, handoffs, documentation steps,
   waits, minutes) and the change from current to future state; the
   standards catalog and the counts a standards map states; the curated
   health IT history catalog and what a timeline view of it contains. The
   model supplies arguments only: every count and every sentence a figure
   states is computed here, and the reference content (stewards, purposes,
   milestone years) is owned here, never taken from the model.
   -------------------------------------------------------------------------- */

/* -- Shared formatting ------------------------------------------------------ */

/** "1 step" / "3 steps". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/* -- Workflow comparison ---------------------------------------------------- */

export const STEP_KINDS = ["task", "decision", "documentation", "communication", "wait"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  task: "Task",
  decision: "Decision",
  documentation: "Documentation",
  communication: "Communication",
  wait: "Wait",
};

export interface WorkflowStep {
  /** One of the workflow's roles. */
  role: string;
  action: string;
  kind: StepKind;
  /** Minutes the step takes; optional. */
  minutes?: number;
}

export interface WorkflowStats {
  steps: number;
  /** Consecutive steps whose role changes. */
  handoffs: number;
  documentation: number;
  decisions: number;
  waits: number;
  /** Total minutes, or null unless every step gives its minutes. */
  minutes: number | null;
  /** For each step: the previous step's role when this step is a handoff. */
  handoffFrom: Array<string | null>;
}

export function workflowStats(steps: ReadonlyArray<WorkflowStep>): WorkflowStats {
  const handoffFrom = steps.map((s, i) => (i > 0 && steps[i - 1]!.role !== s.role ? steps[i - 1]!.role : null));
  const timed = steps.every((s) => typeof s.minutes === "number");
  return {
    steps: steps.length,
    handoffs: handoffFrom.filter((h) => h !== null).length,
    documentation: steps.filter((s) => s.kind === "documentation").length,
    decisions: steps.filter((s) => s.kind === "decision").length,
    waits: steps.filter((s) => s.kind === "wait").length,
    // Rounded to a tenth to keep sums like 0.1 + 0.2 readable.
    minutes: timed ? Math.round(steps.reduce((t, s) => t + s.minutes!, 0) * 10) / 10 : null,
    handoffFrom,
  };
}

/** "Current state: 9 steps, 4 handoffs, 2 documentation steps, 1 wait, 22 min." */
export function stateSentence(label: string, s: WorkflowStats): string {
  const time = s.minutes === null ? "time not given" : `${s.minutes} min`;
  return `${label}: ${plural(s.steps, "step")}, ${plural(s.handoffs, "handoff")}, ${plural(s.documentation, "documentation step")}, ${plural(s.waits, "wait")}, ${time}.`;
}

const arrow = (a: number, b: number, one: string, many = `${one}s`) => `${a} → ${b} ${a === 1 && b === 1 ? one : many}`;

/** "Future state: 9 → 6 steps, 4 → 2 handoffs, 3 → 1 documentation steps,
 *  2 → 0 waits, 18 → 11 min." Only the computed differences; no verdict. */
export function changeSentence(cur: WorkflowStats, fut: WorkflowStats): string {
  const time = cur.minutes !== null && fut.minutes !== null
    ? `${cur.minutes} → ${fut.minutes} min`
    : "time not compared (not every step gives its minutes)";
  return `Future state: ${arrow(cur.steps, fut.steps, "step")}, ${arrow(cur.handoffs, fut.handoffs, "handoff")}, ${arrow(cur.documentation, fut.documentation, "documentation step")}, ${arrow(cur.waits, fut.waits, "wait")}, ${time}.`;
}

/** A signed difference for the table: "−3", "+1", "0"; null when unknown. */
export function fmtDelta(a: number | null, b: number | null): string {
  if (a === null || b === null) return "not given";
  const d = Math.round((b - a) * 10) / 10;
  return d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "0";
}

/* -- Standards map ---------------------------------------------------------- */

export const STANDARD_CATEGORIES = ["terminology", "nursing", "exchange"] as const;
export type StandardCategory = (typeof STANDARD_CATEGORIES)[number];

export const STANDARD_CATEGORY_LABEL: Record<StandardCategory, string> = {
  terminology: "Terminologies and code sets",
  nursing: "Nursing terminologies",
  exchange: "Exchange and document structure",
};

export interface Standard {
  id: string;
  name: string;
  steward: string;
  purpose: string;
  category: StandardCategory;
}

/** The figure's own catalog: names, stewards and purposes never come from
 *  the model. Order within a category is the order the figure lists them. */
export const STANDARDS: ReadonlyArray<Standard> = [
  { id: "loinc", name: "LOINC", category: "terminology", steward: "Regenstrief Institute", purpose: "Names lab tests, clinical observations and many nursing assessments (what was measured or asked)." },
  { id: "snomed-ct", name: "SNOMED CT", category: "terminology", steward: "SNOMED International", purpose: "Clinical findings, problems and procedures, including many nursing concepts." },
  { id: "icd-10-cm", name: "ICD-10-CM", category: "terminology", steward: "CDC National Center for Health Statistics (U.S.)", purpose: "Diagnoses, coded for billing and statistics." },
  { id: "icd-10-pcs", name: "ICD-10-PCS", category: "terminology", steward: "Centers for Medicare & Medicaid Services (CMS)", purpose: "Procedures in U.S. inpatient hospital stays, for billing." },
  { id: "cpt", name: "CPT", category: "terminology", steward: "American Medical Association", purpose: "Medical, surgical and diagnostic services by physicians and other professionals, and hospital outpatient services, for billing." },
  { id: "rxnorm", name: "RxNorm", category: "terminology", steward: "National Library of Medicine", purpose: "Clinical drugs: ingredient, strength and dose form." },
  { id: "ucum", name: "UCUM", category: "terminology", steward: "Regenstrief Institute", purpose: "Units of measure, written so computers can read them (e.g. mg, mm[Hg])." },
  { id: "nanda-i", name: "NANDA-I", category: "nursing", steward: "NANDA International", purpose: "Nursing diagnoses." },
  { id: "nic", name: "NIC", category: "nursing", steward: "University of Iowa College of Nursing", purpose: "Nursing Interventions Classification: the treatments nurses perform." },
  { id: "noc", name: "NOC", category: "nursing", steward: "University of Iowa College of Nursing", purpose: "Nursing Outcomes Classification: patient outcomes that nursing care affects." },
  { id: "omaha", name: "Omaha System", category: "nursing", steward: "Public domain; developed at the Visiting Nurse Association of Omaha", purpose: "Problems, interventions and outcomes in community and home health care." },
  { id: "ccc", name: "CCC", category: "nursing", steward: "Clinical Care Classification System (Virginia Saba)", purpose: "Nursing diagnoses, interventions and outcomes, organised by care components." },
  { id: "icnp", name: "ICNP", category: "nursing", steward: "International Council of Nurses (distributed by SNOMED International)", purpose: "International Classification for Nursing Practice: diagnoses, interventions and outcomes." },
  { id: "hl7-v2", name: "HL7 v2", category: "exchange", steward: "HL7 International", purpose: "Event messages between systems, e.g. ADT (admit, discharge, transfer) and lab results." },
  { id: "fhir", name: "HL7 FHIR", category: "exchange", steward: "HL7 International", purpose: "Web APIs built from resources such as Patient, Observation and MedicationRequest." },
  { id: "c-cda", name: "C-CDA", category: "exchange", steward: "HL7 International", purpose: "Structured clinical documents, such as discharge summaries and continuity of care documents." },
  { id: "dicom", name: "DICOM", category: "exchange", steward: "DICOM Standards Committee (secretariat: MITA, a NEMA division)", purpose: "Medical images and their metadata, and how imaging systems exchange them." },
  { id: "ncpdp-script", name: "NCPDP SCRIPT", category: "exchange", steward: "National Council for Prescription Drug Programs", purpose: "E-prescribing messages between prescribers and pharmacies." },
];

export const STANDARD_IDS: ReadonlyArray<string> = STANDARDS.map((s) => s.id);
const BY_ID = new Map(STANDARDS.map((s) => [s.id, s]));

export function standardById(id: string): Standard | undefined {
  return BY_ID.get(id);
}

/** How a payload is carried by each exchange standard, for the sentence. */
const EXCHANGE_PHRASE: Record<string, (r: string) => string> = {
  "hl7-v2": (r) => `exchanged in HL7 v2 ${r} messages`,
  fhir: (r) => `exchanged as FHIR ${r} resources`,
  "c-cda": (r) => `exchanged in a C-CDA ${r} document`,
  dicom: (r) => `exchanged as DICOM ${r} objects`,
  "ncpdp-script": (r) => `exchanged as NCPDP SCRIPT ${r} messages`,
};

export function exchangePhrase(standardId: string, resource: string): string {
  const f = EXCHANGE_PHRASE[standardId];
  return f ? f(resource) : `exchanged with ${standardById(standardId)?.name ?? standardId} (${resource})`;
}

export interface MappedElement {
  element: string;
  standard: string;
  code?: string;
  display?: string;
}

export interface StandardGroup {
  standard: Standard;
  elements: Array<MappedElement & { index: number }>;
}

/** Elements grouped by standard, standards in catalog order, grouped again
 *  by category in the fixed category order (empty categories dropped). */
export function groupByStandard(elements: ReadonlyArray<MappedElement>) {
  const groups: StandardGroup[] = STANDARDS.map((standard) => ({
    standard,
    elements: elements.map((e, index) => ({ ...e, index })).filter((e) => e.standard === standard.id),
  })).filter((g) => g.elements.length > 0);
  return STANDARD_CATEGORIES.map((category) => ({ category, groups: groups.filter((g) => g.standard.category === category) })).filter(
    (c) => c.groups.length > 0,
  );
}

/** "7 elements across 4 standards: 3 in LOINC, 2 in UCUM, 1 in SNOMED CT and
 *  1 in NANDA-I; exchanged as FHIR Observation resources." Standards ordered
 *  by count, then catalog order. */
export function standardsSentence(elements: ReadonlyArray<MappedElement>, exchange?: { standard: string; resource: string }): string {
  const counts = STANDARDS.map((s, order) => ({ s, order, n: elements.filter((e) => e.standard === s.id).length }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n || a.order - b.order);
  const head = `${plural(elements.length, "element")} across ${plural(counts.length, "standard")}`;
  const parts = counts.map((c) => `${c.n} in ${c.s.name}`);
  const tail = exchange ? `; ${exchangePhrase(exchange.standard, exchange.resource)}` : "";
  return `${head}: ${joinAnd(parts)}${tail}.`;
}

/* -- Health IT timeline ----------------------------------------------------- */

export const MILESTONE_CATEGORIES = ["policy", "report", "standard", "system", "nursing"] as const;
export type MilestoneCategory = (typeof MILESTONE_CATEGORIES)[number];

export const MILESTONE_CATEGORY_LABEL: Record<MilestoneCategory, string> = {
  policy: "Policy",
  report: "Report",
  standard: "Standard",
  system: "System",
  nursing: "Nursing",
};

export interface Milestone {
  id: string;
  year: number;
  label: string;
  category: MilestoneCategory;
}

/** The curated reference list. The model picks ids; it never adds entries. */
export const MILESTONES: ReadonlyArray<Milestone> = [
  { id: "help-system", year: 1967, category: "system", label: "HELP system begins at LDS Hospital, Salt Lake City (early clinical decision support)" },
  { id: "costar", year: 1968, category: "system", label: "COSTAR ambulatory record developed at Massachusetts General Hospital's Laboratory of Computer Science" },
  { id: "hl7-founded", year: 1987, category: "standard", label: "Health Level Seven (HL7) founded" },
  { id: "iom-cpr-report", year: 1991, category: "report", label: "IOM report “The Computer-Based Patient Record: An Essential Technology for Health Care”" },
  { id: "ana-nursing-informatics", year: 1992, category: "nursing", label: "ANA recognizes nursing informatics as a nursing specialty" },
  { id: "hipaa", year: 1996, category: "policy", label: "HIPAA enacted" },
  { id: "to-err-is-human", year: 1999, category: "report", label: "IOM “To Err Is Human”" },
  { id: "quality-chasm", year: 2001, category: "report", label: "IOM “Crossing the Quality Chasm”" },
  { id: "onc-created", year: 2004, category: "policy", label: "Office of the National Coordinator for Health IT (ONC) created by executive order" },
  { id: "fda-bar-code-rule", year: 2004, category: "standard", label: "FDA rule requires bar codes (with the NDC) on most prescription drug labels and hospital OTC drugs (enabling BCMA)" },
  { id: "tiger-initiative", year: 2006, category: "nursing", label: "TIGER (Technology Informatics Guiding Education Reform) summit sets a 10-year vision for nursing informatics" },
  { id: "triple-aim", year: 2008, category: "report", label: "Triple Aim (Berwick, Nolan & Whittington)" },
  { id: "hitech-act", year: 2009, category: "policy", label: "HITECH Act (part of ARRA) funds EHR adoption" },
  { id: "affordable-care-act", year: 2010, category: "policy", label: "Affordable Care Act" },
  { id: "meaningful-use-stage-1", year: 2011, category: "policy", label: "Meaningful Use Stage 1 EHR incentive program begins" },
  { id: "quadruple-aim", year: 2014, category: "report", label: "Quadruple Aim adds care team well-being (Bodenheimer & Sinsky)" },
  { id: "fhir-dstu1", year: 2014, category: "standard", label: "First FHIR draft standard (DSTU1) published" },
  { id: "icd-10-transition", year: 2015, category: "standard", label: "U.S. switches to ICD-10-CM/PCS (Oct 1)" },
  { id: "cures-act", year: 2016, category: "policy", label: "21st Century Cures Act" },
  { id: "promoting-interoperability", year: 2018, category: "policy", label: "CMS renames the Meaningful Use EHR Incentive Programs the Promoting Interoperability Programs" },
  { id: "fhir-r4", year: 2018, category: "standard", label: "FHIR Release 4, the first with normative content" },
  { id: "onc-cures-final-rule", year: 2020, category: "policy", label: "ONC Cures Act Final Rule (information blocking, standardized FHIR APIs)" },
  { id: "information-blocking-effective", year: 2021, category: "policy", label: "Information blocking rules take effect: providers may not block patients' electronic access to their records, including notes" },
  { id: "tefca", year: 2022, category: "policy", label: "TEFCA (Trusted Exchange Framework and Common Agreement) published" },
  { id: "hti-1", year: 2023, category: "policy", label: "ONC HTI-1 Final Rule (transparency for decision support interventions, including AI)" },
];

export const MILESTONE_IDS: ReadonlyArray<string> = MILESTONES.map((m) => m.id);
export const MILESTONE_FIRST_YEAR = MILESTONES[0]!.year;
export const MILESTONE_LAST_YEAR = MILESTONES[MILESTONES.length - 1]!.year;

export interface LocalEvent {
  year: number;
  label: string;
}

export interface TimelineView {
  from: number;
  to: number;
  /** Catalog entries in [from, to], in catalog (year) order. */
  shown: Array<Milestone & { highlighted: boolean }>;
  /** Decades from the decade of `from` to the decade of `to`. */
  decades: number[];
  highlightedCount: number;
}

/** What the timeline shows: every reference milestone in the range (by
 *  default, the years of the highlighted milestones and local events),
 *  with the highlighted ones emphasised. */
export function timelineView(highlight: ReadonlyArray<string> | "all", local: ReadonlyArray<LocalEvent>, range?: { from: number; to: number }): TimelineView {
  const hi = new Set(highlight === "all" ? MILESTONE_IDS : highlight);
  const years = [
    ...MILESTONES.filter((m) => hi.has(m.id)).map((m) => m.year),
    ...local.map((e) => e.year),
  ];
  const from = range ? range.from : Math.min(...years);
  const to = range ? range.to : Math.max(...years);
  const shown = MILESTONES.filter((m) => m.year >= from && m.year <= to).map((m) => ({ ...m, highlighted: hi.has(m.id) }));
  const decades: number[] = [];
  for (let d = Math.floor(from / 10) * 10; d <= to; d += 10) decades.push(d);
  return { from, to, shown, decades, highlightedCount: shown.filter((m) => m.highlighted).length };
}

/** "9 reference milestones from 1999 to 2011 (12 years): 4 policy, 3 report,
 *  1 standard and 1 nursing. 5 highlighted. Plus 1 event added by your
 *  tutor." Categories in the fixed order, zero counts dropped. */
export function timelineSentence(v: TimelineView, localCount: number): string {
  const span = v.to - v.from;
  const when = span === 0 ? `in ${v.from}` : `from ${v.from} to ${v.to} (${plural(span, "year")})`;
  const cats = MILESTONE_CATEGORIES.map((c) => ({ c, n: v.shown.filter((m) => m.category === c).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${MILESTONE_CATEGORY_LABEL[x.c].toLowerCase()}`);
  const head = v.shown.length === 0
    ? `No reference milestones ${when}.`
    : `${plural(v.shown.length, "reference milestone")} ${when}: ${joinAnd(cats)}.`;
  const hl = v.highlightedCount > 0 && v.highlightedCount < v.shown.length ? ` ${v.highlightedCount} highlighted.` : "";
  const local = localCount > 0 ? ` Plus ${plural(localCount, "event")} added by your tutor.` : "";
  return `${head}${hl}${local}`;
}
