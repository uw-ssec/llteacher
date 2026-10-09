/* --------------------------------------------------------------------------
   Runtime validation for the health information systems figure tools
   (workflow comparison, standards map, health IT timeline).

   Same deny-by-default rule as toolInputs.ts: the input is the model's own
   JSON, so every field is checked for type AND for meaning -- a step whose
   role is not one of the lanes, negative minutes, a standard the figure's
   catalog does not know, a terminology used as an exchange format, a
   milestone id that is not on the reference list, a range that leaves out
   a highlighted milestone. Anything wrong returns null, and the registry
   shows nothing rather than a confidently wrong figure.
   -------------------------------------------------------------------------- */

import {
  MILESTONES,
  STEP_KINDS,
  standardById,
  type LocalEvent,
  type MappedElement,
  type StepKind,
  type WorkflowStep,
} from "./lib/systems";
import type { WorkflowComparisonProps } from "./renderers/informatics/WorkflowComparison";
import type { StandardsMapProps } from "./renderers/informatics/StandardsMap";
import type { HealthItTimelineProps } from "./renderers/informatics/HealthItTimeline";

type Obj = Record<string, unknown>;
type Parsed<P> = Omit<P, "isPartial">;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown, max = 200): string | undefined | null =>
  v === undefined ? undefined : typeof v === "string" && v.trim() && v.length <= max ? v : null;
const reqStr = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() && v.length <= max ? v : null);
const isYear = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/* -- Workflow comparison ---------------------------------------------------- */

function parseSteps(v: unknown, roles: ReadonlyArray<string>): WorkflowStep[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) return null;
  const steps: WorkflowStep[] = [];
  for (const s of v) {
    if (!isObj(s)) return null;
    if (typeof s.role !== "string" || !roles.includes(s.role)) return null;
    const action = reqStr(s.action, 100);
    if (action === null) return null;
    if (typeof s.kind !== "string" || !(STEP_KINDS as readonly string[]).includes(s.kind)) return null;
    const m = s.minutes;
    // Minutes for one step: a real duration, at most a day.
    if (m !== undefined && !(typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= 1440)) return null;
    steps.push(m === undefined ? { role: s.role, action, kind: s.kind as StepKind } : { role: s.role, action, kind: s.kind as StepKind, minutes: m as number });
  }
  return steps;
}

export function parseWorkflowComparisonInput(v: unknown): Parsed<WorkflowComparisonProps> | null {
  if (!isObj(v)) return null;
  const process = reqStr(v.process, 100);
  if (process === null || !Array.isArray(v.roles) || v.roles.length < 2 || v.roles.length > 6) return null;
  const roles: string[] = [];
  for (const r of v.roles) {
    const role = reqStr(r, 24);
    if (role === null) return null;
    roles.push(role);
  }
  // Two lanes with the same name would make a step's lane ambiguous.
  if (new Set(roles.map((r) => r.trim().toLowerCase())).size !== roles.length) return null;
  const current = parseSteps(v.current, roles);
  if (current === null) return null;
  const future = v.future === undefined ? undefined : parseSteps(v.future, roles);
  if (future === null) return null;
  const currentLabel = optStr(v.currentLabel, 60);
  const futureLabel = optStr(v.futureLabel, 60);
  if (currentLabel === null || futureLabel === null) return null;
  // A label for a state that is not shown is a mistake, not decoration.
  if (futureLabel !== undefined && future === undefined) return null;
  return { process, roles, current, future, currentLabel, futureLabel };
}

/* -- Standards map ---------------------------------------------------------- */

export function parseStandardsMapInput(v: unknown): Parsed<StandardsMapProps> | null {
  if (!isObj(v)) return null;
  const scenario = reqStr(v.scenario, 120);
  if (scenario === null || !Array.isArray(v.elements) || v.elements.length < 1 || v.elements.length > 12) return null;
  const elements: MappedElement[] = [];
  for (const e of v.elements) {
    if (!isObj(e)) return null;
    const element = reqStr(e.element, 100);
    if (element === null) return null;
    if (typeof e.standard !== "string" || !standardById(e.standard)) return null;
    const code = optStr(e.code, 40);
    const display = optStr(e.display, 120);
    if (code === null || display === null) return null;
    // A code is one token-ish string; prose in the code slot is not a code.
    if (code !== undefined && /\s{2,}|[\n\t]/.test(code)) return null;
    const out: MappedElement = { element, standard: e.standard };
    if (code !== undefined) out.code = code.trim();
    if (display !== undefined) out.display = display;
    elements.push(out);
  }
  let exchange: StandardsMapProps["exchange"];
  if (v.exchange !== undefined) {
    if (!isObj(v.exchange) || typeof v.exchange.standard !== "string") return null;
    // Only an exchange or document standard can carry the elements.
    if (standardById(v.exchange.standard)?.category !== "exchange") return null;
    const resource = reqStr(v.exchange.resource, 40);
    if (resource === null) return null;
    exchange = { standard: v.exchange.standard, resource };
  }
  return exchange ? { scenario, elements, exchange } : { scenario, elements };
}

/* -- Health IT timeline ----------------------------------------------------- */

const MILESTONE_YEAR = new Map(MILESTONES.map((m) => [m.id, m.year]));

export function parseHealthItTimelineInput(v: unknown): Parsed<HealthItTimelineProps> | null {
  if (!isObj(v)) return null;
  let highlight: string[] | "all";
  if (v.highlight === "all") highlight = "all";
  else {
    if (!Array.isArray(v.highlight) || v.highlight.length < 1 || v.highlight.length > MILESTONES.length) return null;
    if (!v.highlight.every((id): id is string => typeof id === "string" && MILESTONE_YEAR.has(id))) return null;
    if (new Set(v.highlight).size !== v.highlight.length) return null;
    highlight = v.highlight;
  }
  const localEvents: LocalEvent[] = [];
  if (v.localEvents !== undefined) {
    if (!Array.isArray(v.localEvents) || v.localEvents.length > 5) return null;
    for (const e of v.localEvents) {
      if (!isObj(e) || !isYear(e.year, 1950, 2035)) return null;
      const label = reqStr(e.label, 120);
      if (label === null) return null;
      localEvents.push({ year: e.year, label });
    }
  }
  let range: HealthItTimelineProps["range"];
  if (v.range !== undefined) {
    if (!isObj(v.range) || !isYear(v.range.from, 1950, 2035) || !isYear(v.range.to, 1950, 2035)) return null;
    if (v.range.from > v.range.to) return null;
    range = { from: v.range.from, to: v.range.to };
    // A range that hides what the tutor asked to highlight or add contradicts itself.
    const r = range;
    const inside = (y: number) => y >= r.from && y <= r.to;
    if (highlight !== "all" && !highlight.every((id) => inside(MILESTONE_YEAR.get(id)!))) return null;
    if (!localEvents.every((e) => inside(e.year))) return null;
    // "all" with a range must still show at least one reference milestone.
    if (highlight === "all" && !MILESTONES.some((m) => inside(m.year))) return null;
  }
  const out: Parsed<HealthItTimelineProps> = { highlight };
  if (range) out.range = range;
  if (localEvents.length) out.localEvents = localEvents;
  return out;
}
