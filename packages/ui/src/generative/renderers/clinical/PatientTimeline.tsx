/* --------------------------------------------------------------------------
   PatientTimeline (`showPatientTimeline`) -- one patient's record over time.

   A swimlane per kind of data present (encounters, vital signs, labs,
   medications, procedures, orders, notes -- always in that order), one
   marker per event on a computed time axis with readable ticks across the
   actual date range. Events too close to share a row stack within their
   lane. An abnormal result is ringed, and says "Abnormal" in words in the
   list, so the flag never rides on colour alone. The SVG is the overview;
   the event labels live in an HTML list beneath it, which reflows on a
   phone instead of colliding.
   -------------------------------------------------------------------------- */

import {
  TIMELINE_CATEGORIES,
  formatDay,
  formatDuration,
  formatWhen,
  parseClinicalTime,
  tickLabel,
  timeAxis,
  type ClinicalTime,
  type TimelineCategory,
} from "../../lib/clinical";
import { FigurePlate } from "../../figure/FigurePlate";

export interface TimelineEvent {
  /** ISO 8601 date ("2026-03-03") or date-time ("2026-03-03T08:40"). */
  time: string;
  category: TimelineCategory;
  label: string;
  detail?: string;
  abnormal?: boolean;
}

export interface PatientTimelineProps {
  patientLabel?: string;
  /** 1-40 events, in any order. */
  events: TimelineEvent[];
  isPartial?: boolean;
}

const LANE: Record<TimelineCategory, string> = {
  encounter: "Encounter",
  vital: "Vital signs",
  lab: "Lab",
  medication: "Medication",
  procedure: "Procedure",
  order: "Order",
  note: "Note",
};

/** Static class lookups: lanes take slots 1-5 in lane order, then neutral. */
const DOT: Record<TimelineCategory, string> = {
  encounter: "gen-dot gen-fill--1",
  vital: "gen-dot gen-fill--2",
  lab: "gen-dot gen-fill--3",
  medication: "gen-dot gen-fill--4",
  procedure: "gen-dot gen-fill--5",
  order: "gen-dot gen-node",
  note: "gen-dot gen-node",
};
const KEY: Record<TimelineCategory, string> = {
  encounter: "gen-fill--1",
  vital: "gen-fill--2",
  lab: "gen-fill--3",
  medication: "gen-fill--4",
  procedure: "gen-fill--5",
  order: "gen-node",
  note: "gen-node",
};
const SWATCH_FOR: Record<TimelineCategory, string> = {
  encounter: "gen-swatch gen-swatch--1",
  vital: "gen-swatch gen-swatch--2",
  lab: "gen-swatch gen-swatch--3",
  medication: "gen-swatch gen-swatch--4",
  procedure: "gen-swatch gen-swatch--5",
  order: "gen-swatch gen-timeline__neutral",
  note: "gen-swatch gen-timeline__neutral",
};

const VB_W = 440;
const PX0 = 114;
const PX1 = 428;
const TOP = 6;
const ROW = 15;
const LANE_PAD = 9;
const MAX_ROWS = 3;
/** Two markers closer than this (viewBox units) go on separate rows. */
const MIN_GAP = 17;

type Placed = TimelineEvent & { t: ClinicalTime; x: number; row: number; index: number };

export function PatientTimeline({ patientLabel, events, isPartial = false }: PatientTimelineProps) {
  const parsed = events.map((e, index) => ({ ...e, t: parseClinicalTime(e.time), index }));
  if (parsed.some((e) => e.t === null)) return null;
  const sorted = (parsed as Array<TimelineEvent & { t: ClinicalTime; index: number }>)
    .slice()
    .sort((a, b) => a.t.at - b.t.at || a.index - b.index);

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const axis = timeAxis(first.t.at, last.t.at, { datesOnly: sorted.every((e) => !e.t.hasTime) });
  const sx = (at: number) => PX0 + ((at - axis.lo) / (axis.hi - axis.lo)) * (PX1 - PX0);
  const multiYear = new Date(first.t.at).getUTCFullYear() !== new Date(last.t.at).getUTCFullYear();

  // Lanes present, in the fixed order; within each, a greedy row stack.
  const lanes = TIMELINE_CATEGORIES.filter((c) => sorted.some((e) => e.category === c)).map((category) => {
    const lastX: number[] = [];
    const placed: Placed[] = sorted.filter((e) => e.category === category).map((e) => {
      const x = sx(e.t.at);
      let row = lastX.findIndex((lx) => x - lx >= MIN_GAP);
      if (row === -1 && lastX.length < MAX_ROWS) row = lastX.length;
      if (row === -1) row = lastX.indexOf(Math.min(...lastX));
      lastX[row] = x;
      return { ...e, x, row };
    });
    return { category, placed, rows: Math.max(1, lastX.length) };
  });
  let y = TOP;
  const laid = lanes.map((l) => {
    const h = LANE_PAD * 2 + l.rows * ROW;
    const lane = { ...l, top: y, h };
    y += h;
    return lane;
  });
  const lanesBottom = y;
  const VB_H = lanesBottom + 40;
  const rowY = (top: number, h: number, rows: number, row: number) => top + h / 2 + (row - (rows - 1) / 2) * ROW;

  const abnormal = sorted.filter((e) => e.abnormal);
  const span = last.t.at - first.t.at;
  const sameYear = !multiYear;
  const range = span === 0 || formatDay(first.t.at, true) === formatDay(last.t.at, true)
    ? formatDay(first.t.at, true)
    : sameYear
      ? `${formatDay(first.t.at)} – ${formatDay(last.t.at, true)}`
      : `${formatDay(first.t.at, true)} – ${formatDay(last.t.at, true)}`;
  const when = (e: { t: ClinicalTime }) => formatWhen(e.t, multiYear);
  const offset = first.t.offset;
  const who = patientLabel ? ` for ${patientLabel}` : "";

  const summary = sorted.length === 1
    ? `1 event, ${when(first)}${multiYear ? "" : `, ${new Date(first.t.at).getUTCFullYear()}`}.`
    : `${sorted.length} events over ${formatDuration(span)}, ${range}.`;
  const abnormalSentence = abnormal.length === 0
    ? "None is flagged abnormal."
    : `${abnormal.length} flagged abnormal; the first is ${abnormal[0]!.label} at ${when(abnormal[0]!)}.`;
  const aria = `Patient timeline${who}: ${summary} Lanes: ${laid.map((l) => `${LANE[l.category]} (${l.placed.length})`).join(", ")}. ${abnormalSentence}`;

  return (
    <FigurePlate
      kicker="Patient timeline"
      title={patientLabel ? `Patient timeline · ${patientLabel}` : "Patient timeline"}
      isPartial={isPartial}
      label={aria}
      takeaway={<>{summary} {abnormalSentence}</>}
      note={offset ? `Times shown as recorded (${offset === "Z" ? "UTC" : `UTC${offset}`}).` : undefined}
      table={{
        caption: "Events in time order",
        head: ["Time", "Category", "Event", "Detail", "Abnormal"],
        rows: sorted.map((e) => [when(e), LANE[e.category], e.label, e.detail ?? "", e.abnormal ? "Yes" : ""]),
      }}
    >
      <svg className="gen-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label={aria}>
        {/* Time grid first, so lanes and markers sit over it. */}
        {axis.ticks.map((t) => (
          <line key={t} className="gen-grid" x1={sx(t)} y1={TOP} x2={sx(t)} y2={lanesBottom} />
        ))}
        {laid.map((l, i) => (
          <g key={l.category}>
            {i > 0 ? <line className="gen-grid" x1={0} y1={l.top} x2={PX1} y2={l.top} /> : null}
            <rect className={KEY[l.category]} x={0} y={l.top + l.h / 2 - 4} width={8} height={8} rx={2} />
            <text className="gen-svg__label" x={13} y={l.top + l.h / 2 + 4}>{LANE[l.category]}</text>
            {l.placed.map((e) => {
              const cy = rowY(l.top, l.h, l.rows, e.row);
              const tip = `${when(e)} · ${LANE[e.category]}: ${e.label}${e.detail ? ` (${e.detail})` : ""}${e.abnormal ? " · abnormal" : ""}`;
              return (
                <g key={e.index}>
                  {e.abnormal ? <circle className="gen-timeline__ring" cx={e.x} cy={cy} r={7.5} /> : null}
                  <circle className={DOT[e.category]} cx={e.x} cy={cy} r={4.5}>
                    <title>{tip}</title>
                  </circle>
                </g>
              );
            })}
          </g>
        ))}
        <line className="gen-axis" x1={PX0} y1={lanesBottom} x2={PX1} y2={lanesBottom} />
        {axis.ticks.map((t, i) => {
          const lab = tickLabel(axis, i);
          const anchor = i === 0 ? "start" : i === axis.ticks.length - 1 ? "end" : "middle";
          return (
            <g key={t}>
              <text className="gen-svg__mono" x={sx(t)} y={lanesBottom + 16} textAnchor={anchor}>{lab.main}</text>
              {lab.sub ? <text className="gen-svg__mono" x={sx(t)} y={lanesBottom + 32} textAnchor={anchor}>{lab.sub}</text> : null}
            </g>
          );
        })}
      </svg>
      {abnormal.length ? (
        <ul className="gen-legend">
          <li className="gen-legend__item"><span className="gen-timeline__ring-key" aria-hidden="true" /><span>Ringed marker = abnormal</span></li>
        </ul>
      ) : null}
      <ol className="gen-timeline__list">
        {sorted.map((e) => (
          <li key={e.index} className="gen-timeline__item">
            <span className="gen-timeline__time">{when(e)}</span>
            <span className="gen-timeline__cat">
              <span className={SWATCH_FOR[e.category]} aria-hidden="true" />
              {LANE[e.category]}
            </span>
            <span className="gen-timeline__event">
              <span className="gen-timeline__label">{e.label}</span>
              {e.detail ? <span className="gen-timeline__detail">{e.detail}</span> : null}
            </span>
            {e.abnormal ? <span className="gen-timeline__flag"><span aria-hidden="true">!</span> Abnormal</span> : null}
          </li>
        ))}
      </ol>
    </FigurePlate>
  );
}
