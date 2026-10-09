/* --------------------------------------------------------------------------
   WorkflowComparison (`showWorkflowComparison`) -- a clinical workflow's
   current state and (optionally) its future state, as swimlanes.

   One vertical lane per role, in the order given; steps run down the page,
   one row each, in their role's lane, numbered. A step's kind (task, decision,
   documentation, communication, wait) is a coloured edge AND a symbol and
   word, never colour alone. A step taken by a different role than the step
   before is a handoff, and says so in words. On a phone the lanes reflow
   into an ordered list with the role written on every step.

   Every count is computed (lib/systems.ts). The figure states only the
   differences between the two states; it never says one is safer.
   -------------------------------------------------------------------------- */

import {
  STEP_KINDS,
  STEP_KIND_LABEL,
  changeSentence,
  fmtDelta,
  stateSentence,
  workflowStats,
  type StepKind,
  type WorkflowStats,
  type WorkflowStep,
} from "../../lib/systems";
import { FigurePlate } from "../../figure/FigurePlate";

export interface WorkflowComparisonProps {
  /** e.g. "Medication administration" */
  process: string;
  /** 2-6 distinct role names; one swimlane each, in this order. */
  roles: string[];
  /** 1-20 steps in order. */
  current: WorkflowStep[];
  /** 1-20 steps in order; omit to show one state only. */
  future?: WorkflowStep[];
  /** Optional short names for the states, e.g. "Paper MAR", "BCMA". */
  currentLabel?: string;
  futureLabel?: string;
  isPartial?: boolean;
}

/** Static class lookups (design-system lint: classes stay literal).
 *  Vertical swimlanes: one column per role, one row per step. */
const LANE = ["gen-sy-lane--1", "gen-sy-lane--2", "gen-sy-lane--3", "gen-sy-lane--4", "gen-sy-lane--5", "gen-sy-lane--6"] as const;
const AT = [
  "gen-sy-at--1", "gen-sy-at--2", "gen-sy-at--3", "gen-sy-at--4", "gen-sy-at--5",
  "gen-sy-at--6", "gen-sy-at--7", "gen-sy-at--8", "gen-sy-at--9", "gen-sy-at--10",
  "gen-sy-at--11", "gen-sy-at--12", "gen-sy-at--13", "gen-sy-at--14", "gen-sy-at--15",
  "gen-sy-at--16", "gen-sy-at--17", "gen-sy-at--18", "gen-sy-at--19", "gen-sy-at--20",
] as const;
const ROLES = ["gen-sy-roles--1", "gen-sy-roles--2", "gen-sy-roles--3", "gen-sy-roles--4", "gen-sy-roles--5", "gen-sy-roles--6"] as const;
const STEPS = [
  "gen-sy-n--1", "gen-sy-n--2", "gen-sy-n--3", "gen-sy-n--4", "gen-sy-n--5",
  "gen-sy-n--6", "gen-sy-n--7", "gen-sy-n--8", "gen-sy-n--9", "gen-sy-n--10",
  "gen-sy-n--11", "gen-sy-n--12", "gen-sy-n--13", "gen-sy-n--14", "gen-sy-n--15",
  "gen-sy-n--16", "gen-sy-n--17", "gen-sy-n--18", "gen-sy-n--19", "gen-sy-n--20",
] as const;
/** Kinds take the categorical slots 1-5 in the fixed kind order. */
const KIND: Record<StepKind, string> = {
  task: "gen-sy-kind--1",
  decision: "gen-sy-kind--2",
  documentation: "gen-sy-kind--3",
  communication: "gen-sy-kind--4",
  wait: "gen-sy-kind--5",
};
const SWATCH: Record<StepKind, string> = {
  task: "gen-swatch gen-swatch--1",
  decision: "gen-swatch gen-swatch--2",
  documentation: "gen-swatch gen-swatch--3",
  communication: "gen-swatch gen-swatch--4",
  wait: "gen-swatch gen-swatch--5",
};
/** A symbol per kind, so the kind never rides on colour alone. */
const GLYPH: Record<StepKind, string> = {
  task: "■",
  decision: "◆",
  documentation: "✎",
  communication: "⇄",
  wait: "◔",
};

interface StateView {
  key: "current" | "future";
  name: string;
  label?: string;
  steps: WorkflowStep[];
  stats: WorkflowStats;
}

function Lanes({ view, roles }: { view: StateView; roles: string[] }) {
  const n = Math.min(view.steps.length, 20);
  return (
    <section className="gen-sy-flow" aria-label={`${view.name}${view.label ? ` (${view.label})` : ""}`}>
      <h3 className="gen-sy-flow__head">
        {view.name}
        {view.label ? <span className="gen-sy-flow__label">{view.label}</span> : null}
      </h3>
      <dl className="gen-stats gen-sy-flow__stats">
        <div className="gen-stat"><dt>Steps</dt><dd>{view.stats.steps}</dd></div>
        <div className="gen-stat"><dt>Handoffs</dt><dd>{view.stats.handoffs}</dd></div>
        <div className="gen-stat"><dt>Documentation</dt><dd>{view.stats.documentation}</dd></div>
        <div className="gen-stat"><dt>Waits</dt><dd>{view.stats.waits}</dd></div>
        <div className="gen-stat"><dt>Time</dt><dd>{view.stats.minutes === null ? "not given" : `${view.stats.minutes} min`}</dd></div>
      </dl>
      <div className="gen-sy-scroll">
        <div className={`gen-sy-lanes ${ROLES[roles.length - 1]} ${STEPS[n - 1]}`}>
          {roles.map((r, i) => (
            <div key={`band-${r}`} className={`gen-sy-band ${LANE[i]}`} aria-hidden="true" />
          ))}
          {roles.map((r, i) => (
            <div key={`lane-${r}`} className={`gen-sy-lane ${LANE[i]}`} aria-hidden="true">{r}</div>
          ))}
          <ol className="gen-sy-steps">
            {view.steps.map((s, i) => {
              const from = view.stats.handoffFrom[i];
              return (
                <li key={i} className={`gen-sy-step ${LANE[roles.indexOf(s.role)]} ${AT[i]} ${KIND[s.kind]}`}>
                  <span className="gen-sy-step__top">
                    <span className="gen-sy-step__num">{i + 1}</span>
                    <span className="gen-sy-step__role">{s.role}</span>
                  </span>
                  <span className="gen-sy-step__action">{s.action}</span>
                  <span className="gen-sy-step__meta">
                    <span className="gen-sy-step__kind">
                      <span className="gen-sy-glyph" aria-hidden="true">{GLYPH[s.kind]}</span>
                      {STEP_KIND_LABEL[s.kind]}
                    </span>
                    {typeof s.minutes === "number" ? <span className="gen-sy-step__min">{s.minutes} min</span> : null}
                  </span>
                  {from ? <span className="gen-sy-step__handoff">Handoff from {from}</span> : null}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}

export function WorkflowComparison({ process, roles, current, future, currentLabel, futureLabel, isPartial = false }: WorkflowComparisonProps) {
  const cur: StateView = { key: "current", name: "Current state", label: currentLabel, steps: current, stats: workflowStats(current) };
  const fut: StateView | null = future
    ? { key: "future", name: "Future state", label: futureLabel, steps: future, stats: workflowStats(future) }
    : null;
  const views = fut ? [cur, fut] : [cur];

  const takeaway = fut ? changeSentence(cur.stats, fut.stats) : stateSentence("Current state", cur.stats);
  const aria = fut
    ? `Workflow comparison, ${process}. ${stateSentence("Current state", cur.stats)} ${takeaway}`
    : `Workflow, ${process}. ${takeaway}`;
  const kindsUsed = STEP_KINDS.filter((k) => views.some((v) => v.steps.some((s) => s.kind === k)));

  const row = (metric: string, pick: (s: WorkflowStats) => number | null) => {
    const a = pick(cur.stats);
    const show = (v: number | null) => (v === null ? "not given" : v);
    return fut ? [metric, show(a), show(pick(fut.stats)), fmtDelta(a, pick(fut.stats))] : [metric, show(a)];
  };

  return (
    <FigurePlate
      kicker={fut ? "Workflow comparison" : "Workflow"}
      title={process}
      isPartial={isPartial}
      label={aria}
      takeaway={<>{takeaway}</>}
      note={
        <>
          A handoff is counted each time the next step belongs to a different role.
          {fut ? " These are counts only: fewer steps or handoffs does not by itself make a process safer." : null}
        </>
      }
      table={{
        caption: fut ? "Workflow measures, current and future state" : "Workflow measures",
        head: fut ? ["Measure", "Current", "Future", "Change"] : ["Measure", "Current"],
        numeric: fut ? [false, true, true, true] : [false, true],
        rows: [
          row("Steps", (s) => s.steps),
          row("Handoffs", (s) => s.handoffs),
          row("Documentation steps", (s) => s.documentation),
          row("Decisions", (s) => s.decisions),
          row("Waits", (s) => s.waits),
          row("Total minutes", (s) => s.minutes),
        ],
      }}
    >
      <ul className="gen-legend gen-sy-legend">
        {kindsUsed.map((k) => (
          <li key={k} className="gen-legend__item">
            <span className={SWATCH[k]} aria-hidden="true" />
            <span className="gen-sy-glyph" aria-hidden="true">{GLYPH[k]}</span>
            <span>{STEP_KIND_LABEL[k]}</span>
          </li>
        ))}
      </ul>
      {views.map((v) => (
        <Lanes key={v.key} view={v} roles={roles} />
      ))}
    </FigurePlate>
  );
}
